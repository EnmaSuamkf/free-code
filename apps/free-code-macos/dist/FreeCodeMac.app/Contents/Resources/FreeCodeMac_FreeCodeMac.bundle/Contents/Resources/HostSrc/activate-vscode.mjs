import { FreeCodeChatViewProvider, resolveSelectionPaths } from "./host.mjs";
import { getVscode } from "./vscode-api-binding.mjs";

/** @param {import("vscode").ExtensionContext} context */
export function activate(context) {
  const vscode = getVscode();
  const provider = new FreeCodeChatViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("freeCode.chatView", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("free-code.attachFiles", async () => {
      try {
        await vscode.commands.executeCommand(
          "workbench.view.extension.freeCode",
        );
      } catch {
        // view id may differ by build; panel can still be opened manually
      }
      const res = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: true,
        canSelectMany: true,
      });
      if (!res || res.length === 0) return;
      const paths = await resolveSelectionPaths(res);
      if (paths.length > 0)
        provider.postToWebview({ type: "insert_paths", paths });
    }),
    vscode.commands.registerCommand("free-code.openAgentBrowser", async () => {
      try {
        await vscode.commands.executeCommand(
          "workbench.view.extension.freeCode",
        );
      } catch {
        // view id may differ by build; panel can still be opened manually
      }
      const url = await vscode.window.showInputBox({
        title: "Open visible browser with agent",
        prompt: "URL to open in a visible agent-controlled browser window",
        placeHolder: "https://example.com",
        ignoreFocusOut: true,
      });
      if (url === undefined) return;
      const instruction = await vscode.window.showInputBox({
        title: "Open visible browser with agent",
        prompt: "Optional goal for the agent after the visible browser opens",
        placeHolder:
          "Inspect the page in the visible browser and wait for my next instruction",
        ignoreFocusOut: true,
      });
      if (instruction === undefined) return;
      await provider.handleOpenAgentBrowser(url, instruction);
    }),
    vscode.commands.registerCommand("free-code.exportChat", async () => {
      try {
        await vscode.commands.executeCommand(
          "workbench.view.extension.freeCode",
        );
      } catch {
        // view id may differ by build
      }
      await provider.handleExportConversation();
    }),
    new vscode.Disposable(() => {
      provider.dispose();
    }),
  );
}

export function deactivate() {}
