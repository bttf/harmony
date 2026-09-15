import { isAuthorized, unauthorized } from './auth.ts';
import { assert } from 'std/assert/assert.ts';
import { assertEquals } from 'std/assert/assert_equals.ts';
import { assertFalse } from 'std/assert/assert_false.ts';
import { describe, it } from '@std/testing/bdd';

const secret = 'c0ffee'.repeat(4);

function makeRequest(authorization?: string): Request {
	return new Request('https://harmony.example/api/waxnerd/lookup', {
		method: 'POST',
		headers: authorization ? { Authorization: authorization } : undefined,
	});
}

describe('Waxnerd API authorization', () => {
	it('rejects every request while no secret is configured', async () => {
		assertFalse(await isAuthorized(makeRequest(`Bearer ${secret}`), undefined));
		assertFalse(await isAuthorized(makeRequest(`Bearer ${secret}`), ''));
	});

	it('rejects a request without an Authorization header', async () => {
		assertFalse(await isAuthorized(makeRequest(), secret));
	});

	it('rejects another authorization scheme', async () => {
		assertFalse(await isAuthorized(makeRequest(`Basic ${secret}`), secret));
	});

	it('rejects a malformed Bearer header', async () => {
		assertFalse(await isAuthorized(makeRequest('Bearer'), secret));
		assertFalse(await isAuthorized(makeRequest(`Bearer ${secret} extra`), secret));
	});

	it('rejects a wrong token', async () => {
		assertFalse(await isAuthorized(makeRequest('Bearer wrong-token'), secret));
	});

	it('accepts the correct token', async () => {
		assert(await isAuthorized(makeRequest(`Bearer ${secret}`), secret));
	});

	it('accepts a lowercase scheme', async () => {
		assert(await isAuthorized(makeRequest(`bearer ${secret}`), secret));
	});
});

describe('unauthorized response', () => {
	it('is a 401 which asks for a bearer token', async () => {
		const response = unauthorized();
		assertEquals(response.status, 401);
		assertEquals(response.headers.get('WWW-Authenticate'), 'Bearer');
		assertEquals(await response.json(), { error: 'unauthorized', code: 'unauthorized' });
	});
});
