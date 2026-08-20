import * as path from "node:path";
import * as net from "node:net";
import * as vscode from "vscode";

let viewerPanel: vscode.WebviewPanel | undefined;
let extensionContext: vscode.ExtensionContext | undefined;
let tcpServer: net.Server | null = null;
let tcpClient: net.Socket | null = null;
let tcpBuffer: string = "";
const jointState: Record<string, number> = {};

const STATION_URDF_RELATIVE = ["models", "station", "station.urdf"] as const;

export function activate(context: vscode.ExtensionContext) {
  console.log("ThreeModelViewer activated");
  extensionContext = context;
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
        "绞刀刀齿装配工位",
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
        } else if (message.type === "requestLoadStation") {
          console.log("requestLoadStation");
          await loadStationModel(viewerPanel!.webview);
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

      await loadStationModel(viewerPanel.webview);
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

  tcpServer.listen(port, "0.0.0.0", () => {
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

function getStationUrdfUri(): vscode.Uri | undefined {
  if (!extensionContext) {
    return undefined;
  }
  return vscode.Uri.joinPath(extensionContext.extensionUri, ...STATION_URDF_RELATIVE);
}

async function loadStationModel(webview: vscode.Webview): Promise<void> {
  const stationUri = getStationUrdfUri();
  if (!stationUri) {
    void vscode.window.showWarningMessage("Extension is not activated.");
    return;
  }

  try {
    await vscode.workspace.fs.stat(stationUri);
  } catch {
    void vscode.window.showWarningMessage(
      `Bundled station URDF not found: ${stationUri.fsPath}`
    );
    return;
  }

  await loadUrdfFromUri(webview, stationUri);
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

  await loadUrdfFromUri(webview, selected[0]);
}

async function loadUrdfFromUri(webview: vscode.Webview, selectedUri: vscode.Uri): Promise<void> {
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

  let stationConfig: unknown = null;
  const stationJsonUri = vscode.Uri.joinPath(selectedDirUri, "station.json");
  try {
    const raw = await vscode.workspace.fs.readFile(stationJsonUri);
    stationConfig = JSON.parse(new TextDecoder("utf-8").decode(raw));
  } catch {
    stationConfig = null;
  }

  let trajectories: unknown = null;
  const trajUri = vscode.Uri.joinPath(selectedDirUri, "trajectories.json");
  try {
    const raw = await vscode.workspace.fs.readFile(trajUri);
    trajectories = JSON.parse(new TextDecoder("utf-8").decode(raw));
  } catch {
    trajectories = null;
  }

  const msg = {
    type: "loadModelUrl",
    fileName: path.basename(selectedUri.fsPath),
    sourcePath: selectedUri.fsPath,
    url: webview.asWebviewUri(selectedUri).toString(),
    workingPath: webview.asWebviewUri(selectedDirUri).toString() + "/",
    packagesPath: webview.asWebviewUri(packagesRootUri).toString(),
    stationConfig,
    trajectories
  };

  console.log(msg);

  await webview.postMessage(msg);
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
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${webview.cspSource} blob: data: https:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; connect-src ${webview.cspSource} blob: data: https://*.vscode-resource.vscode-cdn.net https://*.vscode-cdn.net https:;"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${styleUri}" />
    <title>绞刀刀齿装配工艺包</title>
  </head>
  <body>
    <header class="app-header">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true"></span>
        <div class="brand-text">
          <h1 class="app-title">绞刀刀齿装配工艺包</h1>
          <p class="brand-sub">仿真工位</p>
        </div>
      </div>
      <div class="app-header-tools">
        <span id="status" class="header-status">正在加载工位模型…</span>
        <div class="tool-group">
          <button id="stationButton" class="btn btn-ghost" type="button">加载工位</button>
          <button id="openButton" class="btn btn-ghost" type="button">打开模型</button>
        </div>
        <div class="tool-group">
          <div id="tcpIndicator" class="tcp-indicator disconnected">
            <span class="tcp-dot"></span>
            <span id="tcpLabel">通讯未启动</span>
          </div>
          <button id="tcpToggle" class="btn btn-ghost" type="button">启动通讯</button>
        </div>
      </div>
    </header>

    <div class="workspace">
      <aside class="side-panel left-panel">
        <section class="panel-section">
          <h2 class="section-head">安全控制</h2>
          <div class="btn-row">
            <button type="button" class="btn btn-estop" data-action="急停">急停</button>
            <button type="button" class="btn btn-reset" data-action="复位">复位</button>
          </div>
        </section>

        <section class="panel-section">
          <h2 class="section-head">导轨行程</h2>
          <div class="jog-row">
            <button type="button" class="btn btn-jog" data-action="导轨 -">−</button>
            <span id="railDisplay" class="jog-value">0.00 mm</span>
            <button type="button" class="btn btn-jog" data-action="导轨 +">+</button>
          </div>
          <div class="rail-scale">
            <span>0</span>
            <span class="rail-track"></span>
            <span>2600 mm</span>
          </div>
        </section>

        <section class="panel-section">
          <h2 class="section-head">机械臂关节</h2>
          ${["J1", "J2", "J3", "J4", "J5", "J6"].map((name) => `
          <div class="jog-row">
            <span class="joint-label">${name}</span>
            <button type="button" class="btn btn-jog" data-action="${name} -">−</button>
            <span class="jog-value" data-joint-display="${name}">0.00°</span>
            <button type="button" class="btn btn-jog" data-action="${name} +">+</button>
          </div>`).join("")}
        </section>

        <section class="panel-section">
          <h2 class="section-head">夹具</h2>
          <div class="segmented" role="group" aria-label="夹具开合">
            <button type="button" class="btn btn-segment" data-action="夹紧">夹紧</button>
            <button type="button" class="btn btn-segment is-active" data-action="松开">松开</button>
          </div>
        </section>
      </aside>

      <section class="center-panel">
        <div class="panel-caption">
          <span>三维模型视图</span>
          <span id="viewerHint" class="caption-hint">待命</span>
        </div>
        <div class="viewer-wrap">
          <div id="viewer"></div>
        </div>
      </section>

      <aside class="side-panel right-panel">
        <section class="panel-section">
          <h2 class="section-head">装配工序</h2>
          <div class="process-grid">
            <button type="button" class="btn process-btn" data-action="到取料位"><span class="step-no">01</span>到取料位</button>
            <button type="button" class="btn process-btn" data-action="识别刀齿"><span class="step-no">02</span>识别刀齿</button>
            <button type="button" class="btn process-btn" data-action="夹紧工件"><span class="step-no">03</span>夹紧工件</button>
            <button type="button" class="btn process-btn" data-action="到装配位"><span class="step-no">04</span>到装配位</button>
            <button type="button" class="btn process-btn" data-action="识别点位"><span class="step-no">05</span>识别点位</button>
            <button type="button" class="btn process-btn" data-action="启动装配"><span class="step-no">06</span>启动装配</button>
            <button type="button" class="btn process-btn" data-action="松开工件"><span class="step-no">07</span>松开工件</button>
            <button type="button" class="btn process-btn" data-action="安全回位"><span class="step-no">08</span>安全回位</button>
          </div>
        </section>
        <section class="panel-section">
          <h2 class="section-head">设备连接</h2>
          <div class="btn-row">
            <button type="button" class="btn process-btn" data-action="连接">连接</button>
            <button type="button" class="btn process-btn" data-action="断开">断开</button>
          </div>
        </section>
      </aside>
    </div>

    <footer class="status-bar">
      <div class="status-item is-off" data-key="connect">
        <span class="status-dot"></span>
        <span class="status-k">连接</span>
        <span id="statusConnect" class="status-v">断开</span>
      </div>
      <div class="status-item is-ok" data-key="device">
        <span class="status-dot"></span>
        <span class="status-k">设备</span>
        <span id="statusDevice" class="status-v">正常</span>
      </div>
      <div class="status-item is-ok" data-key="grip">
        <span class="status-dot"></span>
        <span class="status-k">夹具</span>
        <span id="statusGrip" class="status-v">松开</span>
      </div>
      <div class="status-item" data-key="force">
        <span class="status-dot"></span>
        <span class="status-k">夹爪受力</span>
        <span id="statusForce" class="status-v">----</span>
      </div>
      <div class="status-item status-process" data-key="process">
        <span class="status-k">当前工序</span>
        <span id="statusProcess" class="status-v">无</span>
      </div>
    </footer>

    <div id="actionDialog" class="dialog-overlay hidden" role="dialog" aria-modal="true">
      <div class="dialog-card">
        <div id="dialogTitle" class="dialog-title">操作提示</div>
        <div id="dialogMessage" class="dialog-message"></div>
        <div id="dialogChoices" class="dialog-choices hidden"></div>
        <div class="dialog-actions">
          <button type="button" id="dialogCancel" class="dialog-cancel">取消</button>
          <button type="button" id="dialogOk" class="dialog-ok">确定</button>
        </div>
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
