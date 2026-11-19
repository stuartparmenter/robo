const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const gameIdSource = `[${alphabet}]{12}`;
export const gameIdPattern = new RegExp(`^${gameIdSource}$`);

export function makeGameId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => alphabet[byte & 31]).join("");
}
