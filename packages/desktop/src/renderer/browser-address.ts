/** Preserve an in-progress edit when a page redirects or an older submission completes. */
export function browserAddressAfterNavigation(
  address: string,
  url: string,
  submitted: string | null,
  editing = false,
): string {
  if (submitted !== null) return address === submitted ? url : address;
  return editing ? address : url;
}
