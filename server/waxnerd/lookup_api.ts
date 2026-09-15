import { createReleaseSeed } from '@/musicbrainz/seeding.ts';
import { createReleasePermalink } from '@/server/permalink.ts';
import { CompatibilityError, LookupError, ProviderError } from '@/utils/errors.ts';
import { ResponseError as SnapResponseError } from 'snap-storage';
import { simplifyName } from 'utils/string/simplify.js';

import type { MetadataProvider } from '@/providers/base.ts';
import type {
	ArtistCreditName,
	IncompatibilityInfo,
	MergedHarmonyRelease,
	ProviderMessage,
	ProviderReleaseErrorMap,
} from '@/harmonizer/types.ts';
import type { FormDataRecord } from 'utils/types.d.ts';

/** Request body of the Waxnerd release lookup endpoint. */
export interface HarmonyLookupRequest {
	/** Release URL of a supported provider (http/https). */
	url: string;
	/**
	 * Absolute callback URL to which MusicBrainz should redirect after the import.
	 *
	 * Identifiers have to be part of the path, a query string or fragment is rejected:
	 * Harmony replaces the query string with the lookup state and MusicBrainz appends `release_mbid`.
	 */
	redirectUrl: string;
}

/** Result of one provider which took part in the lookup. */
export interface HarmonyLookupProviderResult {
	name: string;
	internalName: string;
	id: string | null;
	url: string | null;
	/** Indicates whether the provider returned a release. */
	lookedUp: boolean;
	/** Error message of a failed provider lookup. */
	error: string | null;
}

/** MusicBrainz release which is already linked to one of the looked up provider releases. */
export interface HarmonyLinkedRelease {
	mbid: string;
	/** Display names of the providers whose release is linked to this MusicBrainz release. */
	providers: string[];
}

/** Successful response of the Waxnerd release lookup endpoint. */
export interface HarmonyLookupResponse {
	/** Merged release, to be stored as received. */
	release: MergedHarmonyRelease;
	/** MusicBrainz release editor seed, as `name`/`value` pairs of a form. */
	seed: FormDataRecord;
	title: string;
	/** Flattened release artist credit. */
	artistCredit: string;
	trackCount: number;
	gtin: string | null;
	provider: { name: string; internalName: string; id: string; url: string };
	/** MBID of an existing MusicBrainz release, if one was found. */
	existingMbid: string | null;
	existingMbidSource: 'url' | 'lookup' | null;
	/**
	 * Indicates whether the MusicBrainz URL relationships could be checked at all.
	 *
	 * This is `false` if the MusicBrainz API failed as well as if its rate limit was hit, which the
	 * resolver reports as a warning instead of an error.
	 */
	existingMbidChecked: boolean;
	linkedReleases: HarmonyLinkedRelease[];
	providers: HarmonyLookupProviderResult[];
	warnings: string[];
	/** Permalink of the equivalent lookup on this Harmony instance. */
	permalink: string;
}

/** Error codes which the Waxnerd API uses. */
export type HarmonyLookupErrorCode =
	| 'unauthorized'
	| 'bad_request'
	| 'unsupported_url'
	| 'not_found'
	| 'provider_error'
	| 'internal';

/** Error response of the Waxnerd API. */
export interface HarmonyLookupError {
	error: string;
	code: HarmonyLookupErrorCode;
	/** Display name of the provider which caused the error, if it is known. */
	provider?: string;
}

/** Result of a validation which either yields a value or an error message. */
export type ValidationResult<T> = ({ ok: true } & T) | { ok: false; error: string };

function parseHttpUrl(value: unknown, property: string): ValidationResult<{ url: URL }> {
	if (typeof value !== 'string' || !value) {
		return { ok: false, error: `Property "${property}" has to be a non-empty string` };
	}

	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return { ok: false, error: `Property "${property}" is not a valid URL` };
	}

	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return { ok: false, error: `Property "${property}" has to use the http or https protocol` };
	}

	return { ok: true, url };
}

/** Validates the request body of the release lookup endpoint. */
export function parseLookupRequest(body: unknown): ValidationResult<{ url: URL; redirectUrl: URL }> {
	if (typeof body !== 'object' || body === null || Array.isArray(body)) {
		return { ok: false, error: 'Request body has to be a JSON object' };
	}

	const { url: urlValue, redirectUrl: redirectUrlValue } = body as Partial<HarmonyLookupRequest>;

	const url = parseHttpUrl(urlValue, 'url');
	if (!url.ok) return url;

	const redirectUrl = parseHttpUrl(redirectUrlValue, 'redirectUrl');
	if (!redirectUrl.ok) return redirectUrl;

	if (redirectUrl.url.search || redirectUrl.url.hash) {
		return {
			ok: false,
			error:
				'Property "redirectUrl" must not have a query string or fragment, all identifiers have to be part of the path',
		};
	}

	return { ok: true, url: url.url, redirectUrl: redirectUrl.url };
}

/**
 * Checks whether the given URL is a release URL of a supported provider.
 *
 * Replicates the checks which the `ReleaseLookup` constructor performs, before any request is made.
 */
export function classifyReleaseUrl(
	url: URL,
	findByUrl: (url: URL) => MetadataProvider | undefined,
): ValidationResult<{ provider: MetadataProvider }> {
	const provider = findByUrl(url);
	if (!provider) {
		return { ok: false, error: `No provider supports ${url}` };
	}

	const entity = provider.extractEntityFromUrl(url);
	if (!entity) {
		return { ok: false, error: `Could not extract entity from ${url}` };
	}

	const releaseType = provider.entityTypeMap['release'];
	const isRelease = Array.isArray(releaseType) ? releaseType.includes(entity.type) : entity.type === releaseType;
	if (!isRelease) {
		return { ok: false, error: `${url} is not a release URL` };
	}

	return { ok: true, provider };
}

/** Removes providers which are unusable because their credentials are not configured. */
export function selectProviders(
	defaults: Set<string>,
	env: { spotifyClientId?: string; spotifyClientSecret?: string },
): Set<string> {
	const selected = new Set(defaults);

	if (!env.spotifyClientId || !env.spotifyClientSecret) {
		selected.delete('spotify');
	}

	return selected;
}

/** Start of the warning which `resolveReleaseMbids` pushes when it hits the MusicBrainz API rate limit. */
const musicbrainzRateLimitWarning = 'Some MusicBrainz URL lookups were skipped because the API rate limit was hit';

/**
 * Checks whether the MusicBrainz resolver reported that it hit the API rate limit.
 *
 * `resolveReleaseMbids` swallows a `RateLimitError` and only pushes a warning message, so the
 * messages which it appended are the only signal that no lookup was performed.
 *
 * @param messages - Release messages after the resolver ran.
 * @param previousMessageCount - Number of messages before the resolver ran.
 */
export function hitMusicBrainzRateLimit(messages: ProviderMessage[], previousMessageCount: number): boolean {
	return messages.slice(previousMessageCount).some((message) =>
		message.type === 'warning' && message.text.startsWith(musicbrainzRateLimitWarning)
	);
}

/** Describes why the data of one provider was dropped from the merged release. */
function describeIncompatibility(
	incompatibility: IncompatibilityInfo,
	incompatibleValue: string | number,
): string {
	let description = `Incompatible data was ignored: ${incompatibility.reason} (${incompatibleValue}`;
	if (incompatibility.compatibleValue !== undefined) {
		description += `, expected ${incompatibility.compatibleValue}`;
	}
	return `${description})`;
}

/** Joins the given artist credit into a single string, the same way the web UI renders it. */
export function formatArtistCredit(artists: ArtistCreditName[]): string {
	const lastIndex = artists.length - 1;

	return artists.map((artist, index) => {
		const displayName = artist.creditedName ?? artist.name;
		const defaultJoinPhrase = (index !== lastIndex) ? (index === lastIndex - 1 ? ' & ' : ', ') : '';
		return displayName + (artist.joinPhrase ?? defaultJoinPhrase);
	}).join('');
}

/** Input of {@linkcode buildLookupResponse}. */
export interface LookupResponseInput {
	release: MergedHarmonyRelease;
	releaseMap: ProviderReleaseErrorMap;
	/** Provider of the release URL which was looked up. */
	inputProvider: MetadataProvider;
	/** Callback URL as it was requested, it will not be modified. */
	redirectUrl: URL;
	/** Base URL of this Harmony instance, for permalinks and edit notes. */
	baseUrl: URL;
	/** Source code URL of this Harmony instance, for edit notes. */
	projectUrl: URL;
	/** Indicates whether the MusicBrainz URL relationships could be checked. */
	mbidsResolved: boolean;
}

/** Builds the response body for a successful release lookup. */
export function buildLookupResponse(input: LookupResponseInput): HarmonyLookupResponse {
	const { release, releaseMap, inputProvider, redirectUrl, baseUrl, projectUrl, mbidsResolved } = input;
	const providerInfos = release.info.providers;

	// `createReleaseSeed` overwrites the query string of the redirect URL, keep the caller's URL intact.
	const seed = createReleaseSeed(release, {
		projectUrl,
		redirectUrl: new URL(redirectUrl),
		seederUrl: baseUrl,
		annotation: {
			availability: false,
			copyright: true,
			textCredits: true,
		},
	});

	// A MusicBrainz provider entry only exists if the input URL was a MusicBrainz release URL.
	const mbInfo = providerInfos.find((provider) => provider.name === 'MusicBrainz' && !provider.isTemplate);
	const inputInfo = providerInfos.find((provider) => provider.internalName === inputProvider.internalName);

	let existingMbid: string | null = null;
	let existingMbidSource: 'url' | 'lookup' | null = null;
	if (mbInfo) {
		existingMbid = mbInfo.id;
		existingMbidSource = 'lookup';
	} else if (inputInfo?.linkedReleases?.length) {
		existingMbid = inputInfo.linkedReleases[0];
		existingMbidSource = 'url';
	}

	const providersByLinkedRelease = new Map<string, string[]>();
	for (const providerInfo of providerInfos) {
		for (const mbid of providerInfo.linkedReleases ?? []) {
			let providerNames = providersByLinkedRelease.get(mbid);
			if (!providerNames) {
				providerNames = [];
				providersByLinkedRelease.set(mbid, providerNames);
			}
			providerNames.push(providerInfo.name);
		}
	}
	const linkedReleases = Array.from(providersByLinkedRelease, ([mbid, providers]) => ({ mbid, providers }));

	const providerResults: HarmonyLookupProviderResult[] = providerInfos.map((providerInfo) => ({
		name: providerInfo.name,
		internalName: providerInfo.internalName,
		id: providerInfo.id,
		url: providerInfo.url,
		lookedUp: true,
		error: null,
	}));
	for (const [providerName, releaseOrError] of Object.entries(releaseMap)) {
		if (releaseOrError instanceof Error) {
			providerResults.push({
				name: providerName,
				internalName: simplifyName(providerName),
				id: null,
				url: null,
				lookedUp: false,
				error: releaseOrError.message,
			});
		}
	}

	const warnings = release.info.messages
		.filter((message) => message.type === 'warning' || message.type === 'error')
		.map((message) => message.provider ? `${message.provider}: ${message.text}` : message.text);

	// Providers whose data is incompatible with the primary provider are deleted from the release map
	// before the merge, so their only remaining trace is the incompatibility info.
	for (const incompatibility of release.info.incompatibleData) {
		for (const cluster of incompatibility.clusters) {
			const description = describeIncompatibility(incompatibility, cluster.incompatibleValue);
			for (const providerInfo of cluster.providers) {
				providerResults.push({
					name: providerInfo.name,
					internalName: providerInfo.internalName,
					id: providerInfo.id,
					url: providerInfo.url,
					lookedUp: true,
					error: description,
				});
				warnings.push(`${providerInfo.name}: ${description}`);
			}
		}
	}

	if (!mbidsResolved) {
		warnings.push('Existing MusicBrainz releases could not be checked, the MusicBrainz URL lookup failed');
	}

	const primaryProvider = providerInfos[0];

	return {
		release,
		seed,
		title: release.title,
		artistCredit: formatArtistCredit(release.artists),
		trackCount: release.media.reduce((count, medium) => count + medium.tracklist.length, 0),
		gtin: release.gtin?.toString() ?? null,
		provider: {
			name: primaryProvider.name,
			internalName: primaryProvider.internalName,
			id: primaryProvider.id,
			url: primaryProvider.url,
		},
		existingMbid,
		existingMbidSource,
		existingMbidChecked: mbidsResolved,
		linkedReleases,
		providers: providerResults,
		warnings,
		permalink: createReleasePermalink(release.info, baseUrl).href,
	};
}

/** Maps an error which was thrown by the combined release lookup to a status code and an error body. */
export function mapLookupError(
	error: unknown,
	inputProviderName: string,
): { status: 400 | 404 | 502 | 500; body: HarmonyLookupError } {
	const cause = (error instanceof AggregateError && error.errors.length) ? error.errors[0] : error;

	if (cause instanceof SnapResponseError) {
		return {
			status: cause.response.status === 404 ? 404 : 502,
			body: {
				error: cause.message,
				code: cause.response.status === 404 ? 'not_found' : 'provider_error',
				provider: inputProviderName,
			},
		};
	}
	if (cause instanceof ProviderError) {
		return { status: 502, body: { error: cause.message, code: 'provider_error', provider: cause.providerName } };
	}
	if (cause instanceof CompatibilityError) {
		// The providers disagree about the release, which says nothing about the requested URL.
		return { status: 502, body: { error: cause.message, code: 'provider_error' } };
	}
	if (cause instanceof LookupError) {
		return { status: 400, body: { error: cause.message, code: 'unsupported_url' } };
	}
	if (cause instanceof Error) {
		return { status: 502, body: { error: cause.message, code: 'provider_error', provider: inputProviderName } };
	}

	return { status: 500, body: { error: 'Internal error', code: 'internal' } };
}

/** Serializes the given body as an uncacheable JSON response. */
export function jsonResponse(body: unknown, status: number): Response {
	return Response.json(body, {
		status,
		headers: { 'Cache-Control': 'no-store' },
	});
}
