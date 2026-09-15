import { getFromEnv } from '@/utils/config.ts';
import { timingSafeEqual } from 'std/crypto/timing_safe_equal.ts';

/**
 * Shared secret which clients have to present to use the Waxnerd API.
 *
 * While it is unset, the API rejects every request.
 */
export const waxnerdApiSecret: string | undefined = getFromEnv('HARMONY_WAXNERD_SECRET');

/** Extracts the token from an `Authorization: Bearer <token>` header value. */
function extractBearerToken(headerValue: string | null): string | undefined {
	if (!headerValue) return;

	const parts = headerValue.split(' ');
	if (parts.length !== 2) return;

	const [scheme, token] = parts;
	if (scheme.toLowerCase() !== 'bearer' || !token) return;

	return token;
}

/**
 * Checks whether the given request carries the expected bearer token.
 *
 * Always returns `false` if no secret is configured.
 * Both values are hashed before they are compared, which allows a constant-time comparison of tokens
 * whose lengths differ.
 */
export async function isAuthorized(req: Request, secret: string | undefined): Promise<boolean> {
	if (!secret) return false;

	const token = extractBearerToken(req.headers.get('Authorization'));
	if (!token) return false;

	const encoder = new TextEncoder();
	const [tokenHash, secretHash] = await Promise.all([
		crypto.subtle.digest('SHA-256', encoder.encode(token)),
		crypto.subtle.digest('SHA-256', encoder.encode(secret)),
	]);

	return timingSafeEqual(tokenHash, secretHash);
}

/** Builds the response for a request which is not authorized. */
export function unauthorized(): Response {
	return Response.json({ error: 'unauthorized', code: 'unauthorized' }, {
		status: 401,
		headers: { 'WWW-Authenticate': 'Bearer' },
	});
}
