/** @type {import("vscode") | null} */
let vscodeApi = null;

/** @param {import("vscode")} api */
export function setVscodeApi(api) {
  vscodeApi = api;
}

export function getVscode() {
  if (!vscodeApi) {
    throw new Error("setVscodeApi() must be called before using the desktop host");
  }
  return vscodeApi;
}
