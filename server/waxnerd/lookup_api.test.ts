import {
	buildLookupResponse,
	classifyReleaseUrl,
	mapLookupError,
	parseLookupRequest,
	selectProviders,
} from './lookup_api.ts';
import BandcampProvider from '@/providers/Bandcamp/mod.ts';
import { makeProviderOptions } from '@/providers/test_spec.ts';
import { LookupError, ProviderError } from '@/utils/errors.ts';
import { ResponseError as SnapResponseError } from 'snap-storage';
import { assert } from 'std/assert/assert.ts';
import { assertEquals } from 'std/assert/assert_equals.ts';
import { assertFalse } from 'std/assert/assert_false.ts';
import { assertStringIncludes } from 'std/assert/assert_string_includes.ts';
import { describe, it } from '@std/testing/bdd';

import type { MetadataProvider } from '@/providers/base.ts';
import type {
	MergedHarmonyRelease,
	ProviderInfo,
	ProviderMessage,
	ProviderReleaseErrorMap,
} from '@/harmonizer/types.ts';

const bandcamp = new BandcampProvider(makeProviderOptions()) as MetadataProvider;
const albumUrl = 'https://theuglykings.bandcamp.com/album/darkness-is-my-home';
const baseUrl = new URL('https://harmony.example/');
const projectUrl = new URL('https://github.com/bttf/harmony');
const redirectUrl = new URL('http://127.0.0.1:4000/waxnerd/release-imports/1234/callback');
const linkedMbid = '4d4b9ec0-3e4f-4a0e-8b2c-a1b2c3d4e5f6';
const otherMbid = '9f8e7d6c-5b4a-4321-9876-0123456789ab';
const existingMbid = '11112222-3333-4444-5555-666677778888';

const bandcampInfo: ProviderInfo = {
	name: 'Bandcamp',
	internalName: 'bandcamp',
	id: 'theuglykings/darkness-is-my-home',
	url: albumUrl,
	lookup: { method: 'id', value: 'theuglykings/darkness-is-my-home' },
};

const deezerInfo: ProviderInfo = {
	name: 'Deezer',
	internalName: 'deezer',
	id: '123456',
	url: 'https://www.deezer.com/album/123456',
	lookup: { method: 'gtin', value: '0123456789012' },
};

const musicbrainzInfo: ProviderInfo = {
	name: 'MusicBrainz',
	internalName: 'musicbrainz',
	id: existingMbid,
	url: `https://musicbrainz.org/release/${existingMbid}`,
	lookup: { method: 'id', value: existingMbid },
};

function makeRelease(providers: ProviderInfo[], messages: ProviderMessage[] = []): MergedHarmonyRelease {
	return {
		title: 'Darkness Is My Home',
		artists: [
			{ name: 'The Ugly Kings', creditedName: 'the ugly kings', joinPhrase: ' feat. ' },
			{ name: 'Some Guest' },
		],
		gtin: '0123456789012',
		externalLinks: [{ url: albumUrl, types: ['free streaming', 'paid download'] }],
		media: [{
			format: 'Digital Media',
			tracklist: [
				{ title: 'Darkness Is My Home', number: 1 },
				{ title: 'Deep Water', number: 2 },
			],
		}],
		info: {
			providers,
			messages,
			sourceMap: {},
			incompatibleData: [],
		},
	};
}

describe('parseLookupRequest', () => {
	it('rejects a body which is not an object', () => {
		for (const body of ['string', 42, null, ['url']]) {
			const result = parseLookupRequest(body);
			assertFalse(result.ok);
		}
	});

	it('rejects a missing or empty URL', () => {
		assertFalse(parseLookupRequest({ redirectUrl: redirectUrl.href }).ok);
		assertFalse(parseLookupRequest({ url: '', redirectUrl: redirectUrl.href }).ok);
	});

	it('rejects a URL which does not use HTTP(S)', () => {
		assertFalse(parseLookupRequest({ url: 'ftp://example.com/album', redirectUrl: redirectUrl.href }).ok);
		assertFalse(parseLookupRequest({ url: 'not a URL', redirectUrl: redirectUrl.href }).ok);
	});

	it('rejects a missing redirect URL', () => {
		assertFalse(parseLookupRequest({ url: albumUrl }).ok);
	});

	it('rejects a redirect URL with a query string or fragment', () => {
		assertFalse(parseLookupRequest({ url: albumUrl, redirectUrl: `${redirectUrl.href}?row=1` }).ok);
		assertFalse(parseLookupRequest({ url: albumUrl, redirectUrl: `${redirectUrl.href}#done` }).ok);
	});

	it('accepts a release URL and a plain redirect URL', () => {
		const result = parseLookupRequest({ url: albumUrl, redirectUrl: redirectUrl.href });
		assert(result.ok);
		assertEquals(result.url.href, albumUrl);
		assertEquals(result.redirectUrl.href, redirectUrl.href);
	});
});

describe('classifyReleaseUrl', () => {
	const findByUrl = (url: URL) => bandcamp.supportsDomain(url) ? bandcamp : undefined;

	it('accepts a release URL of a supported provider', () => {
		const result = classifyReleaseUrl(new URL(albumUrl), findByUrl);
		assert(result.ok);
		assertEquals(result.provider.internalName, 'bandcamp');
	});

	it('rejects a supported URL which is not a release', () => {
		const result = classifyReleaseUrl(new URL('https://theuglykings.bandcamp.com/'), findByUrl);
		assertFalse(result.ok);
		assert(!result.ok && result.error.includes('is not a release URL'));
	});

	it('rejects a supported domain without an entity', () => {
		const result = classifyReleaseUrl(new URL('https://bandcamp.com/discover'), findByUrl);
		assertFalse(result.ok);
	});

	it('rejects a URL of an unsupported host', () => {
		const result = classifyReleaseUrl(new URL('https://example.com/album/1'), findByUrl);
		assertFalse(result.ok);
		assert(!result.ok && result.error.includes('No provider supports'));
	});
});

describe('selectProviders', () => {
	const defaults = new Set(['bandcamp', 'deezer', 'itunes', 'spotify', 'tidal']);

	it('drops Spotify without credentials', () => {
		assertFalse(selectProviders(defaults, {}).has('spotify'));
		assertFalse(selectProviders(defaults, { spotifyClientId: 'id' }).has('spotify'));
		assertFalse(selectProviders(defaults, { spotifyClientId: 'id', spotifyClientSecret: '' }).has('spotify'));
	});

	it('keeps Spotify with credentials', () => {
		assert(selectProviders(defaults, { spotifyClientId: 'id', spotifyClientSecret: 'secret' }).has('spotify'));
	});

	it('does not modify the given defaults', () => {
		selectProviders(defaults, {});
		assert(defaults.has('spotify'));
	});
});

describe('buildLookupResponse', () => {
	const release = makeRelease([
		{ ...bandcampInfo, linkedReleases: [linkedMbid] },
		{ ...deezerInfo, linkedReleases: [otherMbid] },
	], [
		{ provider: 'Deezer', type: 'warning', text: 'Release is not available in your region' },
		{ provider: 'Tidal', type: 'error', text: 'Tidal is unreachable' },
		{ type: 'debug', text: 'Resolving external IDs took 42 ms' },
	]);
	const releaseMap: ProviderReleaseErrorMap = {
		Bandcamp: release,
		Deezer: release,
		Tidal: new Error('Tidal is unreachable'),
	};
	const response = buildLookupResponse({
		release,
		releaseMap,
		inputProvider: bandcamp,
		redirectUrl,
		baseUrl,
		projectUrl,
		mbidsResolved: true,
	});

	it('reports the existing MBID from the URL relationships of the input provider', () => {
		assertEquals(response.existingMbid, linkedMbid);
		assertEquals(response.existingMbidSource, 'url');
		assertEquals(response.existingMbidChecked, true);
	});

	it('groups the linked releases by MBID', () => {
		assertEquals(response.linkedReleases, [
			{ mbid: linkedMbid, providers: ['Bandcamp'] },
			{ mbid: otherMbid, providers: ['Deezer'] },
		]);
	});

	it('lists the failed providers as not looked up', () => {
		assertEquals(response.providers.map((provider) => provider.name), ['Bandcamp', 'Deezer', 'Tidal']);
		assertEquals(response.providers[2], {
			name: 'Tidal',
			internalName: 'tidal',
			id: null,
			url: null,
			lookedUp: false,
			error: 'Tidal is unreachable',
		});
		assertEquals(response.providers[0].lookedUp, true);
	});

	it('formats warnings and errors, but not debug messages', () => {
		assertEquals(response.warnings, [
			'Deezer: Release is not available in your region',
			'Tidal: Tidal is unreachable',
		]);
	});

	it('summarizes the release', () => {
		assertEquals(response.title, 'Darkness Is My Home');
		assertEquals(response.artistCredit, 'the ugly kings feat. Some Guest');
		assertEquals(response.trackCount, 2);
		assertEquals(response.gtin, '0123456789012');
		assertEquals(response.provider.internalName, 'bandcamp');
		assertEquals(response.provider.url, albumUrl);
	});

	it('seeds the release editor with the lookup state in the redirect URI', () => {
		assertEquals(response.seed.name, 'Darkness Is My Home');
		assertEquals(response.seed['mediums.0.track.0.name'], 'Darkness Is My Home');
		assertEquals(response.seed['urls.0.url'], albumUrl);

		const redirectUri = response.seed.redirect_uri as string;
		assert(redirectUri.startsWith(`${redirectUrl.origin}${redirectUrl.pathname}?`));
		assertStringIncludes(redirectUri, 'bandcamp=theuglykings%2Fdarkness-is-my-home');
	});

	it('does not modify the requested redirect URL', () => {
		assertEquals(redirectUrl.search, '');
	});

	it('references this instance in the edit note and the permalink', () => {
		assertStringIncludes(response.seed.edit_note as string, 'https://harmony.example/release?');
		assert(response.permalink.startsWith('https://harmony.example/release?'));
	});

	it('reports an existing MusicBrainz release from the lookup itself', () => {
		const mbRelease = makeRelease([
			{ ...bandcampInfo, linkedReleases: [linkedMbid] },
			musicbrainzInfo,
		]);
		const mbResponse = buildLookupResponse({
			release: mbRelease,
			releaseMap: { Bandcamp: mbRelease, MusicBrainz: mbRelease },
			inputProvider: bandcamp,
			redirectUrl,
			baseUrl,
			projectUrl,
			mbidsResolved: true,
		});

		assertEquals(mbResponse.existingMbid, existingMbid);
		assertEquals(mbResponse.existingMbidSource, 'lookup');
	});

	it('reports no existing MBID if nothing is linked', () => {
		const plainRelease = makeRelease([bandcampInfo]);
		const plainResponse = buildLookupResponse({
			release: plainRelease,
			releaseMap: { Bandcamp: plainRelease },
			inputProvider: bandcamp,
			redirectUrl,
			baseUrl,
			projectUrl,
			mbidsResolved: false,
		});

		assertEquals(plainResponse.existingMbid, null);
		assertEquals(plainResponse.existingMbidSource, null);
		assertEquals(plainResponse.existingMbidChecked, false);
		assertEquals(plainResponse.linkedReleases, []);
		assertEquals(plainResponse.warnings, [
			'Existing MusicBrainz releases could not be checked, the MusicBrainz URL lookup failed',
		]);
	});
});

describe('mapLookupError', () => {
	it('maps a lookup error to an unsupported URL', () => {
		const result = mapLookupError(new LookupError('No provider supports https://example.com/'), 'Bandcamp');
		assertEquals(result.status, 400);
		assertEquals(result.body.code, 'unsupported_url');
	});

	it('maps a provider error to a provider error', () => {
		const result = mapLookupError(
			new AggregateError([new ProviderError('Bandcamp', 'x is not a release URL')], 'No provider returned a release'),
			'Bandcamp',
		);
		assertEquals(result.status, 502);
		assertEquals(result.body.code, 'provider_error');
		assertEquals(result.body.provider, 'Bandcamp');
	});

	it('maps a 404 response error to not found', () => {
		const result = mapLookupError(
			new AggregateError([new SnapResponseError('Request failed', new Response(null, { status: 404 }))]),
			'Bandcamp',
		);
		assertEquals(result.status, 404);
		assertEquals(result.body.code, 'not_found');
		assertEquals(result.body.provider, 'Bandcamp');
	});

	it('maps any other response error to a provider error', () => {
		const result = mapLookupError(
			new SnapResponseError('Request failed', new Response(null, { status: 503 })),
			'Bandcamp',
		);
		assertEquals(result.status, 502);
		assertEquals(result.body.code, 'provider_error');
	});

	it('maps an unexpected error to a provider error', () => {
		const result = mapLookupError(new Error('Connection reset'), 'Bandcamp');
		assertEquals(result.status, 502);
		assertEquals(result.body.code, 'provider_error');
		assertEquals(result.body.provider, 'Bandcamp');
	});

	it('maps a thrown non-error to an internal error', () => {
		const result = mapLookupError('boom', 'Bandcamp');
		assertEquals(result.status, 500);
		assertEquals(result.body.code, 'internal');
	});
});
