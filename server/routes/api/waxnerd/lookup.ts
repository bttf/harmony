import { codeUrl } from '@/config.ts';
import { CombinedReleaseLookup } from '@/lookup.ts';
import { resolveReleaseMbids } from '@/musicbrainz/mbid_mapping.ts';
import { defaultProviderPreferences, defaultProviders, providers } from '@/providers/mod.ts';
import { isAuthorized, unauthorized, waxnerdApiSecret } from '@/server/waxnerd/auth.ts';
import {
	buildLookupResponse,
	classifyReleaseUrl,
	jsonResponse,
	mapLookupError,
	parseLookupRequest,
	selectProviders,
} from '@/server/waxnerd/lookup_api.ts';
import { defaultRegions } from '@/server/state.ts';
import { getFromEnv } from '@/utils/config.ts';
import type { Handlers } from 'fresh/server.ts';
import { getLogger } from 'std/log/get_logger.ts';

import type { MergedHarmonyRelease, ProviderReleaseErrorMap, ReleaseOptions } from '@/harmonizer/types.ts';

/**
 * Looks up a release by provider URL and returns the merged release together with a MusicBrainz seed.
 *
 * Used by the Waxnerd API to import releases, authenticated with a shared secret.
 */
export const handler: Handlers = {
	async POST(req, ctx) {
		const log = getLogger('harmony.server');
		const startTime = performance.now();
		const logResult = (status: number, lookupUrl?: URL) => {
			const elapsedTime = performance.now() - startTime;
			log.info(
				`POST /api/waxnerd/lookup ${lookupUrl ?? '[no URL]'} -> ${status} (${elapsedTime.toFixed(0)} ms)`,
			);
		};

		if (!await isAuthorized(req, waxnerdApiSecret)) {
			logResult(401);
			return unauthorized();
		}

		let body: unknown;
		try {
			body = await req.json();
		} catch {
			logResult(400);
			return jsonResponse({ error: 'Request body is not valid JSON', code: 'bad_request' }, 400);
		}

		const request = parseLookupRequest(body);
		if (!request.ok) {
			logResult(400);
			return jsonResponse({ error: request.error, code: 'bad_request' }, 400);
		}
		const { url, redirectUrl } = request;

		const classification = classifyReleaseUrl(url, (candidate) => providers.findByUrl(candidate));
		if (!classification.ok) {
			logResult(400, url);
			return jsonResponse({ error: classification.error, code: 'unsupported_url' }, 400);
		}
		const inputProvider = classification.provider;

		try {
			const options: ReleaseOptions = {
				withSeparateMedia: true,
				withAllTrackArtists: true,
				withISRC: true,
				regions: new Set(defaultRegions),
				providers: selectProviders(defaultProviders, {
					spotifyClientId: getFromEnv('HARMONY_SPOTIFY_CLIENT_ID'),
					spotifyClientSecret: getFromEnv('HARMONY_SPOTIFY_CLIENT_SECRET'),
				}),
				snapshotMaxTimestamp: undefined,
			};

			let releaseMap: ProviderReleaseErrorMap;
			let release: MergedHarmonyRelease;
			try {
				const lookup = new CombinedReleaseLookup({ urls: [url] }, options);
				releaseMap = await lookup.getCompleteProviderReleaseMapping();
				release = await lookup.getMergedRelease({ prefer: defaultProviderPreferences });
			} catch (error) {
				const { status, body: errorBody } = mapLookupError(error, inputProvider.name);
				logResult(status, url);
				return jsonResponse(errorBody, status);
			}

			// Duplicate detection is a nice to have, a failing MusicBrainz API must not fail the whole lookup.
			let mbidsResolved = true;
			try {
				await resolveReleaseMbids(release);
			} catch (error) {
				mbidsResolved = false;
				log.warn(`Resolving MBIDs failed for ${url}: ${error instanceof Error ? error.message : error}`);
			}

			const response = buildLookupResponse({
				release,
				releaseMap,
				inputProvider,
				redirectUrl,
				baseUrl: new URL('/', ctx.url),
				projectUrl: codeUrl,
				mbidsResolved,
			});

			logResult(200, url);
			return jsonResponse(response, 200);
		} catch (error) {
			log.error(error);
			logResult(500, url);
			return jsonResponse({ error: 'Internal error', code: 'internal' }, 500);
		}
	},
};
