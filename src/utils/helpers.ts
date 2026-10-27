/**
 * Formats a numeric value as an Angolan Kwanza currency string with no
 * decimal places.
 */
export function formatPrice(value: number | string | null | undefined): string {
  const num = typeof value === 'number' ? value : Number(value);
  if (value === null || value === undefined || isNaN(num)) {
    return '0 AOA';
  }
  return new Intl.NumberFormat("pt-AO", {
    style: "currency",
    currency: "AOA",
    maximumFractionDigits: 0,
  }).format(num);
}

/**
 * Title-cases each word of the given text, lower-casing the rest of each
 * word first.
 */
export function capitalize(text: string): string {
  if (!text) return text;
  return text
    .toLowerCase()
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Returns a promise that resolves after the given number of milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Formats a date or date string as a "dd/mm/yyyy hh:mm" string in the
 * Africa/Luanda timezone, returning null for a missing or invalid input.
 */
export function formatDateTime(value: Date | string | null): string | null {
  if (!value) return null;
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return null;

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Luanda",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("day")}/${get("month")}/${get("year")} ${get("hour")}:${get("minute")}`;
}

/**
 * Formats a customer's saved delivery address for admin messages, appending a
 * Google Maps link when the address came from a shared WhatsApp location
 * (lat/lng set) so staff/couriers get the exact delivery point.
 */
export function formatAddressWithMap(
  address: string | null | undefined,
  lat: string | number | null | undefined,
  lng: string | number | null | undefined,
  fallback: string
): string {
  const text = address || fallback;
  if (lat === null || lat === undefined || lng === null || lng === undefined) return text;
  return `${text}\n🗺️ https://maps.google.com/?q=${lat},${lng}`;
}
