// The vault's local day.
//
// Capture dates, filename prefixes, and the modified column in list_notes all use
// this value so the vault has one consistent definition of a calendar day.
//
// The zone comes from VAULT_TZ, which Terraform sets to an IANA time-zone name.
// Intl handles daylight-saving changes. An invalid value falls back to UTC rather
// than failing Lambda initialization.
const TZ = process.env.VAULT_TZ ?? "UTC";

function makeFormatter(zone: string): Intl.DateTimeFormat {
  // en-CA formats as YYYY-MM-DD, which is the shape every vault filename uses.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

let formatter: Intl.DateTimeFormat;
try {
  formatter = makeFormatter(TZ);
} catch {
  console.warn(`VAULT_TZ=${JSON.stringify(TZ)} is not a valid IANA time zone; falling back to UTC.`);
  formatter = makeFormatter("UTC");
}

export function localDay(at: number = Date.now()): string {
  return formatter.format(new Date(at));
}
