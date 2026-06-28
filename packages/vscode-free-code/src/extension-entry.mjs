import * as vscode from "vscode";
import { activate, deactivate } from "@free/free-desktop-host/activate-vscode";
import { setVscodeApi } from "@free/free-desktop-host/vscode-api-binding";

setVscodeApi(vscode);

export { activate, deactivate };
