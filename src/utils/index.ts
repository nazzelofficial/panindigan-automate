/**
 * Self-contained helpers shared across the library.
 *
 * The identifier formats here are Messenger protocol details, not arbitrary
 * random strings: `epoch_id`, message ids and `threading_id` fields expect
 * these exact shapes.
 */

/**
 * Generates an offline threading id.
 *
 * The epoch-milliseconds value shifted left by 22 bits with a 22-bit random
 * suffix, encoded as a decimal string. This reproduces the classic
 * algorithm — the timestamp's binary form prepended to 22 random bits, then
 * converted from binary to decimal — which yields the 63-bit identifier
 * Messenger expects in `epoch_id` fields and client-generated message ids.
 */
export function generateOfflineThreadingId(): string {
  const random = Math.floor(Math.random() * 4_194_304); // 2^22
  return ((BigInt(Date.now()) << 22n) | BigInt(random)).toString();
}

/**
 * Generates a Titan threading id for the `threading_id` field of
 * message-sending forms.
 *
 * Shape: `<timestamp:random-clientId@mail.projektitan.com>`.
 */
export function generateThreadingId(clientId: string): string {
  const random = Math.floor(Math.random() * 4_294_967_295);
  return `<${Date.now()}:${random}-${clientId}@mail.projektitan.com>`;
}
