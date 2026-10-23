/**
 * The compact terminal input on a phone (Settings → Terminal → Compact input line): the input
 * line is one short row, and the key bar folds away behind a button at the end of that line.
 * Off, the line and the bar are what they always were.
 */

export interface KeyBarFoldInput {
  /** the Compact input line setting */
  compact: boolean;
  /** the folded bar's button last left it shown on this device */
  shown: boolean;
  /** the input line is on screen: it holds the button that brings the bar back */
  inputLine: boolean;
}

/**
 * Whether the key bar is folded away. Only a line that is on screen can fold it: with direct
 * typing, or while the masked input stands in for the line, the bar is the one place left that
 * switches the keyboard back, so it stays.
 */
export function keyBarFolded({ compact, shown, inputLine }: KeyBarFoldInput): boolean {
  return compact && inputLine && !shown;
}
