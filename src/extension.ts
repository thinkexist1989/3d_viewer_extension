import * as path from "node:path";
import * as net from "node:net";
import * as vscode from "vscode";

let viewerPanel: vscode.WebviewPanel | undefined;
let tcpServer: net.Server | null = null;
let tcpClient: net.Socket | null = null;
let tcpBuffer: string = "";
const jointState: Record<string, number> = {};

export function activate(context: vscode.ExtensionContext) {
  console.log("ThreeModelViewer activated");
  const openViewerCommand = vscode.commands.registerCommand(
    "threeModelViewer.openViewer",
    async () => {
      console.log("openViewer command");
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

      viewerPanel.webview.onDidReceiveMessage(async (message: { type?: string; [key: string]: unknown }) => {
        if (message.type === "requestOpenModel") {
          console.log("requestOpenModel");
          await requestAndLoadModel(viewerPanel!.webview);
        } else if (message.type === "startTcp") {
          const port = getTcpPort();
          startTcpServer(port);
        } else if (message.type === "stopTcp") {
          stopTcpServer();
        } else if (message.type === "setJointAngles") {
          const angles = message.angles as Record<string, number> | undefined;
          if (angles) {
            Object.assign(jointState, angles);
          }
        }
      });

      viewerPanel.onDidDispose(() => {
        stopTcpServer();
        viewerPanel = undefined;
      });

      await requestAndLoadModel(viewerPanel.webview);
    }
  );

  context.subscriptions.push(openViewerCommand);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("threeModelViewer.tcpPort") && tcpServer) {
        const port = getTcpPort();
        stopTcpServer();
        startTcpServer(port);
      }
    })
  );
}

export function deactivate() {
  stopTcpServer();
  viewerPanel?.dispose();
}

function getTcpPort(): number {
  return vscode.workspace.getConfiguration("threeModelViewer").get<number>("tcpPort", 50051);
}

function startTcpServer(port: number): void {
  if (tcpServer) {
    stopTcpServer();
  }

  tcpServer = net.createServer((socket) => {
    if (tcpClient) {
      tcpClient.destroy();
    }
    tcpClient = socket;
    tcpBuffer = "";

    postToWebview({ type: "tcpStatus", connected: true, port });

    socket.on("data", (data) => {
      tcpBuffer += data.toString();
      let newlineIdx: number;
      while ((newlineIdx = tcpBuffer.indexOf("\n")) !== -1) {
        const line = tcpBuffer.substring(0, newlineIdx).trim();
        tcpBuffer = tcpBuffer.substring(newlineIdx + 1);
        if (!line) continue;
        try {
          const angles = JSON.parse(line) as Record<string, number>;
          Object.assign(jointState, angles);
          postToWebview({ type: "jointAngles", angles, source: "tcp" });
        } catch {
          // Ignore malformed JSON lines
        }
      }
    });

    socket.on("close", () => {
      if (tcpClient === socket) {
        tcpClient = null;
      }
      postToWebview({ type: "tcpStatus", connected: false, port });
    });

    socket.on("error", () => {
      if (tcpClient === socket) {
        tcpClient = null;
      }
      postToWebview({ type: "tcpStatus", connected: false, port });
    });
  });

  tcpServer.on("error", (err) => {
    void vscode.window.showWarningMessage(`TCP server error on port ${port}: ${err.message}`);
    postToWebview({ type: "tcpStatus", connected: false, port, error: err.message });
    tcpServer = null;
    tcpClient = null;
  });

  tcpServer.listen(port, "127.0.0.1", () => {
    postToWebview({ type: "tcpStatus", connected: false, port, listening: true });
  });
}

function stopTcpServer(): void {
  if (tcpClient) {
    tcpClient.destroy();
    tcpClient = null;
  }
  if (tcpServer) {
    tcpServer.close();
    tcpServer = null;
  }
  tcpBuffer = "";
}

function postToWebview(message: Record<string, unknown>): void {
  viewerPanel?.webview.postMessage(message);
}

async function requestAndLoadModel(webview: vscode.Webview): Promise<void> {
  console.log("showOpenDialog");
  const selected = await vscode.window.showOpenDialog({
    canSelectMany: false,
    canSelectFiles: true,
    canSelectFolders: false,
    openLabel: "Open URDF Model",
    filters: {
      "URDF Models": ["urdf"]
    }
  });
  console.log("selected =", selected);
  if (!selected || selected.length === 0) {
    console.log("cancel");
    return;
  }

  const selectedUri = selected[0];
  console.log("selectedUri =", selectedUri.fsPath);
  const selectedDirUri = vscode.Uri.file(path.dirname(selectedUri.fsPath));
  const packagesRootUri = vscode.Uri.file(path.dirname(selectedDirUri.fsPath));

  ensureResourceRoot(webview, selectedDirUri);
  ensureResourceRoot(webview, packagesRootUri);

  const lowerPath = selectedUri.path.toLowerCase();

  if (!lowerPath.endsWith(".urdf")) {
    void vscode.window.showWarningMessage("Only .urdf files are supported.");
    return;
  }

  // webview.postMessage({
  //   type: "loadModelUrl",
  //   fileName: path.basename(selectedUri.fsPath),
  //   sourcePath: selectedUri.fsPath,
  //   url: webview.asWebviewUri(selectedUri).toString(),
  //   workingPath: webview.asWebviewUri(selectedDirUri).toString() + "/",
  //   packagesPath: webview.asWebviewUri(packagesRootUri).toString()
  // });

  const msg = {
      type: "loadModelUrl",
      fileName: path.basename(selectedUri.fsPath),
      sourcePath: selectedUri.fsPath,
      url: webview.asWebviewUri(selectedUri).toString(),
      workingPath: webview.asWebviewUri(selectedDirUri).toString() + "/",
      packagesPath: webview.asWebviewUri(packagesRootUri).toString()
  };

  console.log(msg);

  webview.postMessage(msg);
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
  const viewportGizmoUri = webview.asWebviewUri(
    vscode.Uri.joinPath(
      extensionUri,
      "node_modules",
      "three-viewport-gizmo",
      "dist",
      "three-viewport-gizmo.js"
    )
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
      <button id="openButton" type="button">Open URDF</button>
      <span id="status">No model loaded</span>
      <div id="tcpIndicator" class="tcp-indicator disconnected">
        <span class="tcp-dot"></span>
        <span id="tcpLabel">TCP: Off</span>
      </div>
    </div>
    <div class="main-content">
      <div id="viewer"></div>
      <div id="jointPanel" class="joint-panel collapsed">
        <div class="joint-panel-header">
          <span>Joint Control</span>
          <button id="tcpToggle" class="tcp-btn" type="button">Start TCP</button>
        </div>
        <div id="jointList" class="joint-list"></div>
      </div>
    </div>

    <script nonce="${nonce}" type="importmap">
      {
        "imports": {
          "three": "${threeUri}",
          "three/addons/": "${threeAddonsUri}/",
          "three/examples/jsm/": "${threeAddonsUri}/",
          "urdf-loader": "${urdfLoaderUri}",
          "three-viewport-gizmo": "${viewportGizmoUri}"
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
