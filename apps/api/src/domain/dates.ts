const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** DD MMM YYYY, matching the frontend's display date format. */
export function ddMmmYyyy(date: Date): string {
  const dd = String(date.getDate()).padStart(2, '0');
  return `${dd} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}
