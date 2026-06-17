import * as path from "node:path";
import * as vscode from "vscode";

let viewerPanel: vscode.WebviewPanel | undefined;

export function activate(context: vscode.ExtensionContext) {
  const openViewerCommand = vscode.commands.registerCommand(
    "threeModelViewer.openViewer",
    async () => {
      if (viewerPanel) {
        viewerPanel.reveal(vscode.ViewColumn.Beside);
        return;
      }

      viewerPanel = vscode.window.createWebviewPanel(
        "threeModelViewer",
        "3D Model Viewer",
        vscode.ViewColumn.Beside,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [
            context.extensionUri,
            vscode.Uri.file(path.parse(process.cwd()).root),
            ...(vscode.workspace.workspaceFolders ?? []).map((w) => w.uri)
          ]
        }
      );

      viewerPanel.webview.html = getWebviewHtml(viewerPanel.webview, context.extensionUri);

      viewerPanel.webview.onDidReceiveMessage(async (message: { type?: string }) => {
        if (message.type === "requestOpenModel") {
          await requestAndLoadModel(viewerPanel!.webview);
        }
      });

      viewerPanel.onDidDispose(() => {
        viewerPanel = undefined;
      });

      await requestAndLoadModel(viewerPanel.webview);
    }
  );

  context.subscriptions.push(openViewerCommand);
}

export function deactivate() {
  viewerPanel?.dispose();
}

async function requestAndLoadModel(webview: vscode.Webview): Promise<void> {
  const selected = await vscode.window.showOpenDialog({
    canSelectMany: false,
    canSelectFiles: true,
    canSelectFolders: false,
    openLabel: "Open URDF Model",
    filters: {
      "URDF Models": ["urdf"]
    }
  });

  if (!selected || selected.length === 0) {
    return;
  }

  const selectedUri = selected[0];
  const selectedDirUri = vscode.Uri.file(path.dirname(selectedUri.fsPath));
  // One level up from the URDF directory — typically the robot package root.
  // Used by URDFLoader to resolve package:// paths.
  const packagesRootUri = vscode.Uri.file(path.dirname(selectedDirUri.fsPath));

  ensureResourceRoot(webview, selectedDirUri);
  ensureResourceRoot(webview, packagesRootUri);

  const lowerPath = selectedUri.path.toLowerCase();

  if (!lowerPath.endsWith(".urdf")) {
    void vscode.window.showWarningMessage("Only .urdf files are supported.");
    return;
  }

  // Let urdf-loader fetch the URDF and its mesh resources directly via webview URIs.
  webview.postMessage({
    type: "loadModelUrl",
    fileName: path.basename(selectedUri.fsPath),
    sourcePath: selectedUri.fsPath,
    url: webview.asWebviewUri(selectedUri).toString(),
    workingPath: webview.asWebviewUri(selectedDirUri).toString() + "/",
    packagesPath: webview.asWebviewUri(packagesRootUri).toString()
  });
}

function ensureResourceRoot(webview: vscode.Webview, dirUri: vscode.Uri): void {
  const currentRoots = webview.options.localResourceRoots ?? [];
  if (currentRoots.some((root) => root.toString() === dirUri.toString())) {
    return;
  }

  webview.options = {
    ...webview.options,
    localResourceRoots: [...currentRoots, dirUri]
  };
}

function getWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = createNonce();

  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "webview.js"));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "webview.css"));
  const threeUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "node_modules", "three", "build", "three.module.js")
  );
  const threeAddonsUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "node_modules", "three", "examples", "jsm")
  );
  const urdfLoaderUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "node_modules", "urdf-loader", "src", "URDFLoader.js")
  );

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${webview.cspSource} blob: data: https:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; connect-src ${webview.cspSource} blob: data: https://*.vscode-resource.vscode-cdn.net https://*.vscode-cdn.net https:;"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${styleUri}" />
    <title>3D Model Viewer</title>
  </head>
  <body>
    <div class="toolbar">
      <button id="openButton" type="button">Open .urdf</button>
      <span id="status">No model loaded</span>
    </div>
    <div id="viewer"></div>

    <script nonce="${nonce}" type="importmap">
      {
        "imports": {
          "three": "${threeUri}",
          "three/addons/": "${threeAddonsUri}/",
          "three/examples/jsm/": "${threeAddonsUri}/",
          "urdf-loader": "${urdfLoaderUri}"
        }
      }
    </script>
    <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
  </body>
</html>`;
}

function createNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let i = 0; i < 32; i += 1) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}
