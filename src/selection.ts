/** A file the user picked, with its preview URL (revoked by the App's janitor). */
export interface SelectedFile {
  id: string;
  file: File;
  url: string;
  width?: number;
  height?: number;
}

let counter = 0;

export function toSelected(file: File): SelectedFile {
  return { id: `sel-${++counter}`, file, url: URL.createObjectURL(file) };
}
