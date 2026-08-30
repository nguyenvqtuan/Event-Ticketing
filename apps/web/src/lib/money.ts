/** Minor units to a formatted amount. Shared so one page cannot format differently. */
export const money = (minor: number, currency: string) =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(minor / 100);
