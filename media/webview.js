import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { MTLLoader } from "three/addons/loaders/MTLLoader.js";
import URDFLoader from "urdf-loader";
import { ViewportGizmo } from "three-viewport-gizmo";
import { solveIkRobust, waypointToJ6Target, fkArm, modouPointToRail, modouJointsToUrdf } from "./ik.js";
console.log("webview loaded");
// Use Z-up convention throughout: affects ViewportGizmo coordinate conversions
// and the default up vector for all Object3D instances.
THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

const vscode = acquireVsCodeApi();

const viewerElement = document.getElementById("viewer");
const openButton = document.getElementById("openButton");
const stationButton = document.getElementById("stationButton");
const statusElement = document.getElementById("status");
const tcpIndicator = document.getElementById("tcpIndicator");
const tcpLabel = document.getElementById("tcpLabel");
const tcpToggleBtn = document.getElementById("tcpToggle");
const dropOverlayElement = document.createElement("div");
dropOverlayElement.className = "drop-overlay";
dropOverlayElement.textContent = "将工位 URDF 拖放到此处";
viewerElement.appendChild(dropOverlayElement);

const capsuleToolbar = document.createElement("div");
capsuleToolbar.className = "capsule-toolbar";
viewerElement.appendChild(capsuleToolbar);

const axesBtn = document.createElement("button");
axesBtn.className = "capsule-btn";
axesBtn.id = "axesButton";
axesBtn.textContent = "坐标轴";
capsuleToolbar.appendChild(axesBtn);

const viewerHint = document.getElementById("viewerHint");

function fmt(vec, digits = 3) {
  if (!vec) return "null";
  return `[${[...vec].map((v) => Number(v).toFixed(digits)).join(", ")}]`;
}

function deg6(q) {
  return q.map((v) => ((v * 180) / Math.PI).toFixed(1)).join(", ");
}

function debugPrint(line) {
  const text = typeof line === "string" ? line : JSON.stringify(line);
  console.debug("[station]", text);
}

function readJointWorld(name) {
  const joint = currentUrdfRobot?.joints?.[name];
  if (!joint) return null;
  currentUrdfRobot.updateMatrixWorld(true);
  const p = new THREE.Vector3();
  joint.getWorldPosition(p);
  return [p.x, p.y, p.z];
}

function probeScene(tag) {
  const map = jointMap();
  const rail = jointAngles[map.rail] ?? 0;
  const q = currentArmQ();
  const fk = fkArm(rail, q);
  const threeRail = readJointWorld(map.rail);
  const threeJ6 = readJointWorld(map.j6);
  const modelPos = currentModel
    ? [currentModel.position.x, currentModel.position.y, currentModel.position.z]
    : null;
  debugPrint(`${tag} q_deg=${deg6(q)} rail=${(rail * 1000).toFixed(1)}mm`);
  debugPrint(`${tag} FK_j6(m)=${fmt(fk.t)}`);
  debugPrint(`${tag} THREE_j6=${fmt(threeJ6)} THREE_rail=${fmt(threeRail)}`);
  debugPrint(`${tag} model.offset=${fmt(modelPos)}`);
  if (threeJ6 && threeRail) {
    const rel = [threeJ6[0] - threeRail[0], threeJ6[1] - threeRail[1], threeJ6[2] - threeRail[2]];
    const fkRail = [-4.089, -2.005, 3.89559784 + rail];
    const fkRel = [fk.t[0] - fkRail[0], fk.t[1] - fkRail[1], fk.t[2] - fkRail[2]];
    debugPrint(`${tag} THREE_j6-rail=${fmt(rel)}`);
    debugPrint(`${tag} FK_j6-rail=${fmt(fkRel)}`);
    debugPrint(`${tag} rel_delta=${fmt([rel[0] - fkRel[0], rel[1] - fkRel[1], rel[2] - fkRel[2]])}`);
  }
}

const scene = new THREE.Scene();
scene.background = new THREE.Color("#10141a");

const camera = new THREE.PerspectiveCamera(
  60,
  Math.max(viewerElement.clientWidth, 1) / Math.max(viewerElement.clientHeight, 1),
  0.1,
  1000
);
camera.position.set(3, -3, 2);
camera.up.set(0, 0, 1);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(Math.max(viewerElement.clientWidth, 1), Math.max(viewerElement.clientHeight, 1));
viewerElement.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 0, 0.5);
controls.update();

const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
scene.add(ambientLight);

const directionalLight = new THREE.DirectionalLight(0xffffff, 1.1);
directionalLight.position.set(4, 8, 6);
scene.add(directionalLight);

const grid = new THREE.GridHelper(20, 20, 0x3f3f46, 0x2a2a30);
grid.rotation.x = Math.PI / 2;
scene.add(grid);

const gizmo = new ViewportGizmo(camera, renderer, {
  container: viewerElement,
  placement: "bottom-left",
  size: 100
});
gizmo.attachControls(controls);

const loader = new GLTFLoader();
const urdfLoader = new URDFLoader();

const _defaultMeshLoader = urdfLoader.defaultMeshLoader.bind(urdfLoader);
urdfLoader.loadMeshCb = (meshPath, manager, material, done) => {
  if (/\.obj$/i.test(meshPath)) {
    const mtlPath = meshPath.replace(/\.obj$/i, ".mtl");
    const basePath = meshPath.substring(0, meshPath.lastIndexOf("/") + 1);

    const applyObj = (mtlResult) => {
      const objLoader = new OBJLoader(manager);
      if (mtlResult) {
        mtlResult.preload();
        for (const mat of Object.values(mtlResult.materials)) {
          mat.side = THREE.DoubleSide;
          mat.wireframe = false;
          if (mat.specular) mat.specular.setRGB(0.08, 0.08, 0.08);
          mat.shininess = 25;
        }
        objLoader.setMaterials(mtlResult);
      }
      objLoader.load(
        meshPath,
        (obj) => {
          done(obj);
        },
        undefined,
        (err) => done(null, err)
      );
    };

    const mtlLoader = new MTLLoader(manager);
    mtlLoader.setResourcePath(basePath);
    mtlLoader.load(mtlPath, applyObj, undefined, () => applyObj(null));
  } else if (/\.glb$/i.test(meshPath) || /\.gltf$/i.test(meshPath)) {
    loader.load(
      meshPath,
      (gltf) => {
        gltf.scene.traverse((child) => {
          if (!child.isMesh) return;
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          mats.forEach((m) => {
            if (!m) return;
            m.wireframe = false;
            m.needsUpdate = true;
          });
        });
        done(gltf.scene);
      },
      undefined,
      (err) => done(null, err)
    );
  } else {
    _defaultMeshLoader(meshPath, manager, material, done);
  }
};
let currentModel = null;
let currentUrdfRobot = null;
let dragDepth = 0;
let loadingSource = "unknown";
let lastFailedUrl = "";
let axesVisible = false;
const originalMaterialProps = new Map();
let jointAxesHelpers = [];

// Joint control state
let tcpConnected = false;
let tcpListening = false;
const jointAngles = {};

loader.manager.onError = (url) => {
  lastFailedUrl = String(url ?? "");
  console.error("[Three Model Viewer] Resource load failed:", lastFailedUrl);
};

openButton?.addEventListener("click", () => {
  vscode.postMessage({ type: "requestOpenModel" });
});

stationButton?.addEventListener("click", () => {
  setStatus("正在加载工位模型…");
  vscode.postMessage({ type: "requestLoadStation" });
});

const actionDialog = document.getElementById("actionDialog");
const dialogTitle = document.getElementById("dialogTitle");
const dialogMessage = document.getElementById("dialogMessage");
const dialogChoices = document.getElementById("dialogChoices");
const dialogOk = document.getElementById("dialogOk");
const dialogCancel = document.getElementById("dialogCancel");
const statusConnect = document.getElementById("statusConnect");
const statusDevice = document.getElementById("statusDevice");
const statusGrip = document.getElementById("statusGrip");
const statusForce = document.getElementById("statusForce");
const statusProcess = document.getElementById("statusProcess");
const railDisplay = document.getElementById("railDisplay");

let stationConfig = null;
let trajectories = null;
let eStopLocked = false;
let deviceConnected = false;
let motionToken = 0;
let currentProcess = "无";
let gripperOpen = true;
let selectedPickId = null;
let selectedPlaceId = null;
let dialogResolver = null;

function hideActionDialog(result = null) {
  actionDialog?.classList.add("hidden");
  if (dialogResolver) {
    const resolve = dialogResolver;
    dialogResolver = null;
    resolve(result);
  }
}

function showMessageDialog(title, message) {
  return new Promise((resolve) => {
    hideActionDialog(null);
    dialogResolver = resolve;
    if (dialogTitle) dialogTitle.textContent = title;
    if (dialogMessage) {
      dialogMessage.textContent = message;
      dialogMessage.classList.remove("hidden");
    }
    dialogChoices?.classList.add("hidden");
    if (dialogChoices) dialogChoices.innerHTML = "";
    dialogOk?.classList.remove("hidden");
    actionDialog?.classList.remove("hidden");
  });
}

function showChoiceDialog(title, items) {
  return new Promise((resolve) => {
    hideActionDialog(null);
    dialogResolver = resolve;
    if (dialogTitle) dialogTitle.textContent = title;
    dialogMessage?.classList.add("hidden");
    if (dialogChoices) {
      dialogChoices.innerHTML = "";
      dialogChoices.classList.remove("hidden");
      for (const item of items) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "choice-btn";
        btn.textContent = item.label;
        btn.addEventListener("click", (event) => {
          event.stopPropagation();
          hideActionDialog(item.id);
        });
        dialogChoices.appendChild(btn);
      }
    }
    dialogOk?.classList.add("hidden");
    actionDialog?.classList.remove("hidden");
  });
}

dialogOk?.addEventListener("click", (event) => {
  event.stopPropagation();
  hideActionDialog(true);
});

dialogCancel?.addEventListener("click", (event) => {
  event.stopPropagation();
  hideActionDialog(null);
});

actionDialog?.addEventListener("click", (event) => {
  if (event.target === actionDialog) {
    hideActionDialog(null);
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    hideActionDialog(null);
  }
});

function jointMap() {
  return stationConfig?.joints ?? {
    rail: "link_002_joint",
    j1: "link_003_joint",
    j2: "link_004_joint",
    j3: "joint_6",
    j4: "link_007_joint",
    j5: "link_009_joint",
    j6: "link_010_joint",
    coaxial: "link_008_joint"
  };
}

function setStatusItem(key, on, alarm = false) {
  const item = document.querySelector(`[data-key="${key}"]`);
  if (!item) return;
  item.classList.toggle("is-ok", !!on && !alarm);
  item.classList.toggle("is-off", !on && !alarm);
  item.classList.toggle("is-alarm", !!alarm);
}

function updateProcessBar() {
  if (statusConnect) statusConnect.textContent = deviceConnected ? "已连接" : "断开";
  setStatusItem("connect", deviceConnected);
  if (statusDevice) statusDevice.textContent = eStopLocked ? "急停锁定" : "正常";
  setStatusItem("device", !eStopLocked, eStopLocked);
  if (statusGrip) statusGrip.textContent = gripperOpen ? "松开" : "夹紧";
  setStatusItem("grip", true);
  if (statusForce) statusForce.textContent = "----";
  if (statusProcess) statusProcess.textContent = currentProcess;
  document.querySelector('[data-action="松开"]')?.classList.toggle("is-active", gripperOpen);
  document.querySelector('[data-action="夹紧"]')?.classList.toggle("is-active", !gripperOpen);
  if (viewerHint) {
    viewerHint.textContent = eStopLocked ? "急停锁定" : currentProcess === "无" ? "待命" : currentProcess;
  }
}

function syncManualDisplays() {
  const map = jointMap();
  const railName = map.rail;
  const railVal = jointAngles[railName] ?? 0;
  if (railDisplay) {
    railDisplay.textContent = `${urdfToRailMm(railVal).toFixed(2)} mm`;
  }
  const keys = ["j1", "j2", "j3", "j4", "j5", "j6"];
  keys.forEach((key, index) => {
    const el = document.querySelector(`[data-joint-display="J${index + 1}"]`);
    if (!el) return;
    const val = jointAngles[map[key]] ?? 0;
    el.textContent = `${(val * 180 / Math.PI).toFixed(2)}°`;
  });
}

function setProcessButtonsLocked(locked) {
  document.querySelectorAll("[data-action]").forEach((button) => {
    const action = button.getAttribute("data-action") || "";
    if (action === "急停") {
      button.disabled = false;
      return;
    }
    if (action === "复位") {
      button.disabled = false;
      return;
    }
    button.disabled = locked;
  });
}

function cancelMotion() {
  motionToken += 1;
}

function railSpec() {
  const spec = stationConfig?.rail ?? {};
  const zero = Number(spec.zero_mm);
  const sign = Number(spec.sign);
  return {
    zero: Number.isFinite(zero) ? zero : 2600,
    sign: Number.isFinite(sign) ? sign : -1
  };
}

function railMmToUrdf(railMm) {
  const { zero, sign } = railSpec();
  return sign * (Number(railMm) - zero) / 1000;
}

function urdfToRailMm(urdfM) {
  const { zero, sign } = railSpec();
  return zero + sign * Number(urdfM) * 1000;
}

function poseFromRecord(record, extra = {}) {
  const map = jointMap();
  const pose = { ...(stationConfig?.home ?? {}) };
  Object.assign(pose, extra);
  if (record && typeof record.rail_mm === "number") {
    pose[map.rail] = railMmToUrdf(record.rail_mm);
  }
  if (record?.joints && typeof record.joints === "object") {
    Object.assign(pose, record.joints);
  }
  return pose;
}

function currentArmQ() {
  const map = jointMap();
  return [map.j1, map.j2, map.j3, map.j4, map.j5, map.j6].map((name) => jointAngles[name] ?? 0);
}

function targetsFromIk(q, railM) {
  const map = jointMap();
  const pose = {
    [map.rail]: railM,
    [map.j1]: q[0],
    [map.j2]: q[1],
    [map.j3]: q[2],
    [map.j4]: q[3],
    [map.j5]: q[4],
    [map.j6]: q[5]
  };
  if (map.coaxial) pose[map.coaxial] = 0;
  return pose;
}

function getTooth(id) {
  return trajectories?.teeth?.find((tooth) => tooth.id === id) ?? null;
}

function getWaypoint(tooth, name) {
  return tooth?.waypoints?.find((wp) => wp.name === name) ?? null;
}

async function moveToWaypoint(wp) {
  if (!wp) {
    debugPrint("moveToWaypoint: wp is null");
    return false;
  }
  const toolZ = Math.abs(trajectories?.tcp_to_j6_z_mm ?? 450);
  debugPrint("----");
  debugPrint(`WP ${wp.name} seq=${wp.seq ?? "-"} tooth_rail=${wp.rail_mm}mm`);
  debugPrint(`墨斗TCP(mm)=${fmt([wp.x, wp.y, wp.z], 2)} rpy=${fmt([wp.rx, wp.ry, wp.rz], 1)}`);
  const seed = currentArmQ();
  const railM = railMmToUrdf(wp.rail_mm);
  if (Array.isArray(wp.joints_deg) && wp.joints_deg.length >= 6) {
    debugPrint(`墨斗示教(文件)=${wp.joints_deg.map((v) => Number(v).toFixed(4)).join(", ")}`);
    const taught = modouJointsToUrdf(wp.joints_deg);
    debugPrint(`插件关节=墨斗且J1+180 → ${deg6(taught.q)}`);
    if (!taught.ok) {
      await showMessageDialog("示教点转换失败", `${wp.name} 墨斗关节换到 URDF 误差 ${taught.err.toFixed(3)} m`);
      return false;
    }
    setStatus(`${wp.name} 使用墨斗示教关节`);
    const moved = await moveToJoints(targetsFromIk(taught.q, railM), 1800);
    probeScene(`after ${wp.name}`);
    return moved;
  }
  debugPrint(`seed_q_deg=${deg6(seed)} seed_rail=${((jointAngles[jointMap().rail] ?? 0) * 1000).toFixed(1)}mm`);
  const { pd, Rd, pmRail, j6Cad, toolOffsetCad } = waypointToJ6Target(wp, toolZ, railM);
  debugPrint(`TCP1=STOOL(0,0,${toolZ}): J6=TCP-R*(0,0,${toolZ}) offset_cad(m)=${fmt(toolOffsetCad)}`);
  debugPrint(`J6_cad(m)=${fmt(j6Cad)} → J6_rail(m)=${fmt(pmRail)}`);
  debugPrint(`IK target world pd(m)=${fmt(pd)} railM=${railM.toFixed(3)}`);
  debugPrint(`Rd_z=${fmt([Rd[0][2], Rd[1][2], Rd[2][2]])}`);
  const result = solveIkRobust(railM, pd, Rd, seed);
  debugPrint(`IK ok=${result.ok} err=${result.err.toFixed(5)} it=${result.iterations} q_deg=${deg6(result.q)}`);
  const fkAfter = fkArm(railM, result.q);
  debugPrint(`FK(q*) j6=${fmt(fkAfter.t)}  fk-pd=${fmt([fkAfter.t[0] - pd[0], fkAfter.t[1] - pd[1], fkAfter.t[2] - pd[2]])}`);
  if (!result.ok) {
    await showMessageDialog("逆解失败", `${wp.name} 误差 ${result.err.toFixed(3)} m，请检查该点是否可达。`);
    return false;
  }
  setStatus(`IK ${wp.name} 误差 ${result.err.toFixed(4)} m`);
  const moved = await moveToJoints(targetsFromIk(result.q, railM), 1800);
  probeScene(`after ${wp.name}`);
  return moved;
}

function shortestRevoluteDelta(from, to) {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function moveToJoints(targets, durationMs = 1600) {
  if (!currentUrdfRobot?.joints) {
    return Promise.resolve(false);
  }
  if (eStopLocked) {
    return Promise.resolve(false);
  }

  const start = {};
  const delta = {};
  const names = Object.keys(targets);
  for (const name of names) {
    start[name] = jointAngles[name] ?? 0;
    const joint = currentUrdfRobot.joints[name];
    const isRevolute = joint?.jointType === "revolute" || joint?.jointType === "continuous";
    delta[name] = isRevolute
      ? shortestRevoluteDelta(start[name], targets[name])
      : targets[name] - start[name];
  }

  const token = ++motionToken;
  const t0 = performance.now();

  return new Promise((resolve) => {
    const step = (now) => {
      if (token !== motionToken || eStopLocked) {
        resolve(false);
        return;
      }
      const u = Math.min(1, (now - t0) / Math.max(durationMs, 1));
      const s = u * u * (3 - 2 * u);
      const next = {};
      for (const name of names) {
        next[name] = start[name] + delta[name] * s;
      }
      applyJointAngles(next, true);
      syncManualDisplays();
      if (u < 1) {
        requestAnimationFrame(step);
      } else {
        resolve(true);
      }
    };
    requestAnimationFrame(step);
  });
}

async function runProcess(name, work) {
  if (eStopLocked && name !== "复位") {
    await showMessageDialog("急停锁定", "请先点击复位解除急停。");
    return;
  }
  currentProcess = name;
  updateProcessBar();
  setStatus(`执行: ${name}`);
  try {
    await work();
    if (!eStopLocked) {
      setStatus(`${name} 完成`);
    }
  } catch (error) {
    setStatus(`${name} 中断`);
    console.error(error);
  }
  updateProcessBar();
}

async function handleAction(action) {
  if (action === "急停") {
    eStopLocked = true;
    cancelMotion();
    currentProcess = "急停";
    setProcessButtonsLocked(true);
    updateProcessBar();
    setStatus("急停已触发，夹具保持");
    return;
  }

  if (action === "复位") {
    eStopLocked = false;
    setProcessButtonsLocked(false);
    currentProcess = "无";
    updateProcessBar();
    setStatus("急停已解除");
    return;
  }

  if (action === "连接") {
    deviceConnected = true;
    updateProcessBar();
    setStatus("已切换为连接模式（仿真仍只驱动模型）");
    return;
  }

  if (action === "断开") {
    deviceConnected = false;
    updateProcessBar();
    setStatus("已断开，纯仿真模式");
    return;
  }

  if (action === "导轨 -" || action === "导轨 +") {
    const map = jointMap();
    const step = stationConfig?.steps?.rail_m ?? 0.05;
    const cur = jointAngles[map.rail] ?? 0;
    const next = action === "导轨 +" ? cur + step : cur - step;
    applyJointAngles({ [map.rail]: next }, true);
    syncManualDisplays();
    return;
  }

  const jointStep = action.match(/^(J[1-6]) ([+-])$/);
  if (jointStep) {
    const map = jointMap();
    const key = `j${jointStep[1].slice(1)}`;
    const jointName = map[key];
    const step = stationConfig?.steps?.joint_rad ?? 0.08726646;
    const cur = jointAngles[jointName] ?? 0;
    const next = jointStep[2] === "+" ? cur + step : cur - step;
    applyJointAngles({ [jointName]: next }, true);
    syncManualDisplays();
    return;
  }

  if (action === "夹紧" || action === "松开") {
    await setGripperVisual(action === "松开");
    return;
  }

  if (action === "到取料位") {
    const items = (trajectories?.teeth ?? stationConfig?.pick ?? []).map((item) => ({
      id: item.id,
      label: item.label
    }));
    const picked = await showChoiceDialog("选择刀齿编号", items);
    if (picked == null) return;
    selectedPickId = picked;
    selectedPlaceId = picked;
    await runProcess("到取料位", async () => {
      const tooth = getTooth(picked);
      if (tooth) {
        await moveToWaypoint(getWaypoint(tooth, "pick_approach"));
        return;
      }
      const record = stationConfig?.pick?.find((item) => item.id === picked);
      if (record) await moveToJoints(poseFromRecord(record), 2200);
    });
    return;
  }

  if (action === "到装配位") {
    const items = (trajectories?.teeth ?? stationConfig?.place ?? []).map((item) => ({
      id: item.id,
      label: item.label
    }));
    const picked = await showChoiceDialog("选择齿座编号", items);
    if (picked == null) return;
    selectedPlaceId = picked;
    await runProcess("到装配位", async () => {
      const tooth = getTooth(picked);
      if (tooth) {
        await moveToWaypoint(getWaypoint(tooth, "assemble_approach"));
        return;
      }
      const record = stationConfig?.place?.find((item) => item.id === picked);
      if (record) await moveToJoints(poseFromRecord(record), 2400);
    });
    return;
  }

  if (action === "识别刀齿") {
    await runProcess("识别刀齿", async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    return;
  }

  if (action === "识别点位") {
    await runProcess("识别点位", async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    return;
  }

  if (action === "夹紧工件") {
    await runProcess("夹紧工件", async () => {
      const tooth = getTooth(selectedPickId);
      if (tooth) {
        await moveToWaypoint(getWaypoint(tooth, "pick"));
      }
      await setGripperVisual(false);
      if (tooth) {
        await moveToWaypoint(getWaypoint(tooth, "pick_lift"));
      }
    });
    return;
  }

  if (action === "启动装配") {
    await runProcess("启动装配", async () => {
      const tooth = getTooth(selectedPlaceId);
      if (tooth) {
        await moveToWaypoint(getWaypoint(tooth, "assemble"));
      }
    });
    return;
  }

  if (action === "松开工件") {
    await runProcess("松开工件", async () => {
      await setGripperVisual(true);
      const tooth = getTooth(selectedPlaceId);
      if (tooth) {
        await moveToWaypoint(getWaypoint(tooth, "assemble_retract"));
      }
    });
    return;
  }

  if (action === "安全回位") {
    debugPrint("----");
    debugPrint("安全回位 → URDF home (q=0, rail=0)。墨斗 safe=(0,-1500,1000) 不是导出零位，不走 IK。");
    await runProcess("安全回位", async () => {
      await setGripperVisual(true);
      const home = { ...(stationConfig?.home ?? {}) };
      await moveToJoints(home, 2000);
      probeScene("after 安全回位");
      updateProcessBar();
    });
  }
}

document.querySelectorAll("[data-action]").forEach((button) => {
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const action = button.getAttribute("data-action") || button.textContent.trim();
    void handleAction(action);
  });
});

document.querySelectorAll(".side-panel").forEach((panel) => {
  panel.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
  });
});

axesBtn.addEventListener("click", () => {
  axesVisible = !axesVisible;
  axesBtn.classList.toggle("active", axesVisible);
  updateAxesMode();
});

tcpToggleBtn?.addEventListener("click", (event) => {
  event.stopPropagation();
  console.log("[webview] tcpToggle clicked, listening=", tcpListening);
  if (tcpListening) {
    vscode.postMessage({ type: "stopTcp" });
  } else {
    vscode.postMessage({ type: "startTcp" });
  }
});

viewerElement.addEventListener("dragenter", (event) => {
  event.preventDefault();
  dragDepth += 1;
  viewerElement.classList.add("drag-active");
  setStatus("松开以加载 URDF");
});

viewerElement.addEventListener("dragover", (event) => {
  event.preventDefault();
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = "copy";
  }
});

viewerElement.addEventListener("dragleave", (event) => {
  event.preventDefault();
  dragDepth = Math.max(dragDepth - 1, 0);
  if (dragDepth === 0) {
    viewerElement.classList.remove("drag-active");
    setStatus(currentModel ? "工位模型已加载" : "未加载模型");
  }
});

viewerElement.addEventListener("drop", async (event) => {
  event.preventDefault();
  dragDepth = 0;
  viewerElement.classList.remove("drag-active");

  const file = getFirstModelFile(event.dataTransfer?.files);
  if (!file) {
    setStatus("未找到 URDF 文件");
    return;
  }

  await loadModelFromFile(file);
});

window.addEventListener("resize", () => {
  resize();
});

if (typeof ResizeObserver === "function" && viewerElement) {
  const viewerResize = new ResizeObserver(() => resize());
  viewerResize.observe(viewerElement);
}

window.addEventListener("dragover", (event) => {
  event.preventDefault();
});

window.addEventListener("drop", (event) => {
  event.preventDefault();
});

window.addEventListener("message", async (event) => {
  console.log("message =", event.data);
  const message = event.data;
  if (message.type === "loadModelUrl") {
    loadingSource = "open-dialog-url";
    lastFailedUrl = "";
    const fileName = typeof message.fileName === "string" ? message.fileName : "model";
    const sourcePath = typeof message.sourcePath === "string" ? message.sourcePath : fileName;
    const url = typeof message.url === "string" ? message.url : "";
    const workingPath = typeof message.workingPath === "string" ? message.workingPath : "";
    const packagesPath = typeof message.packagesPath === "string" ? message.packagesPath : "";
    stationConfig = message.stationConfig && typeof message.stationConfig === "object"
      ? message.stationConfig
      : null;
    trajectories = message.trajectories && typeof message.trajectories === "object"
      ? message.trajectories
      : null;

    if (!url) {
      setStatus("加载失败：未提供模型地址");
      return;
    }

    setStatus(`正在加载 ${fileName}…`);

    try {
      urdfLoader.workingPath = workingPath;
      if (packagesPath) {
        urdfLoader.packages = packagesPath;
      }
      const robot = await urdfLoader.loadAsync(url);

      applyLoadedModel(robot);
      currentUrdfRobot = robot;
      updateAxesMode();
      initJointState();
      syncManualDisplays();
      updateProcessBar();
      const extra = trajectories?.teeth ? " · 轨迹已加载" : (stationConfig ? " · 工位点位已加载" : "");
      setStatus(`工位已加载 · ${countMovableJoints()} 个关节${extra}`);
      debugPrint(`loaded ${fileName} traj=${Boolean(trajectories?.teeth)} teeth=${trajectories?.teeth?.length ?? 0}`);
      const jaws = collectGripperJaws();
      debugPrint(`夹爪 visuals A=${jaws.a.length} B=${jaws.b.length} (${jaws.a.map((o) => o.name).join(",")}/${jaws.b.map((o) => o.name).join(",")})`);
      debugPrint(`TCP1 STOOL z=${Math.abs(trajectories?.tcp_to_j6_z_mm ?? 450)} mm (J6=TCP-R*(0,0,z))`);
      debugPrint(`rail map zero=${stationConfig?.rail?.zero_mm} sign=${stationConfig?.rail?.sign}`);
      debugPrint(`墨斗→URDF: p_rail = J1 + Rx90(p_cad)  J1=${fmt(modouPointToRail([0, 0, 0]))}`);
      probeScene("q=0 after load");
      const homeFk = fkArm(0, [0, 0, 0, 0, 0, 0]);
      debugPrint(`FK home j6(m)=${fmt(homeFk.t)}  // CAD/URDF zero, not 墨斗 safe`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const details = buildLoadErrorDetails(errorMessage);
      setStatus(details);
      console.error("[Three Model Viewer] loadModelUrl failed", {
        source: loadingSource,
        fileName,
        url,
        error,
        lastFailedUrl
      });
    }
  } else if (message.type === "jointAngles") {
    const angles = message.angles;
    if (angles && typeof angles === "object") {
      applyJointAngles(angles, message.source === "tcp");
    }
  } else if (message.type === "tcpStatus") {
    console.log("[webview] tcpStatus:", message);
    tcpConnected = !!message.connected;
    tcpListening = !!message.listening;
    updateTcpIndicator();
    if (message.error) {
      setStatus(`TCP error: ${message.error}`);
    }
  }
});

animate();

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);

  gizmo.render();
}

function resize() {
  const width = Math.max(viewerElement.clientWidth, 1);
  const height = Math.max(viewerElement.clientHeight, 1);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height);
  gizmo.update();
}

async function loadModelFromFile(file) {
  lastFailedUrl = "";
  loadingSource = "drag-drop";
  const lowerName = file.name.toLowerCase();
  setStatus(`正在加载 ${file.name}…`);

  try {
    if (lowerName.endsWith(".urdf")) {
      const text = await file.text();
      urdfLoader.workingPath = "";
      const robot = urdfLoader.parse(text);
      robot.rotation.x = -Math.PI / 2;
      applyLoadedModel(robot);
      currentUrdfRobot = robot;
      updateAxesMode();
      initJointState();
      setStatus(`模型已加载：${file.name} · ${countMovableJoints()} 个关节（拖放可能缺少网格）`);
      return;
    }

    setStatus("不支持的文件类型，请使用 .urdf");
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const details = buildLoadErrorDetails(errorMessage);
    setStatus(details);
    console.error("[Three Model Viewer] loadModelFromFile failed", {
      source: loadingSource,
      fileName: file.name,
      error,
      lastFailedUrl
    });
  }
}

function applyLoadedModel(sceneObject) {
  if (currentModel) {
    scene.remove(currentModel);
    disposeObject(currentModel);
  }

  jointAxesHelpers = [];
  originalMaterialProps.clear();
  gripperJawBase.clear();
  gripperClosedAmt = 0;
  gripperOpen = true;
  currentModel = sceneObject;
  currentUrdfRobot = null;

  sceneObject.traverse((child) => {
    if (!child.isMesh) return;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    mats.forEach((m) => {
      if (!m) return;
      m.wireframe = false;
      m.needsUpdate = true;
    });
  });

  scene.add(currentModel);
  frameObject(currentModel);
}

function getFirstModelFile(fileList) {
  if (!fileList || fileList.length === 0) {
    return null;
  }

  for (const file of fileList) {
    const lowerName = file.name.toLowerCase();
    if (lowerName.endsWith(".urdf")) {
      return file;
    }
  }

  return null;
}

function frameObject(object3d) {
  const box = new THREE.Box3().setFromObject(object3d);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  object3d.position.sub(center);

  const maxDim = Math.max(size.x, size.y, size.z, 0.1);
  const distance = maxDim * 1.8;

  camera.position.set(distance, -distance, distance * 0.7);
  controls.target.set(0, 0, 0);
  controls.update();
}

function disposeObject(root) {
  root.traverse((child) => {
    if (child.isMesh) {
      child.geometry?.dispose();
      if (Array.isArray(child.material)) {
        child.material.forEach((material) => material.dispose?.());
      } else {
        child.material?.dispose?.();
      }
    }
  });
}

function setStatus(text) {
  if (statusElement) {
    statusElement.textContent = text;
  }
}

// ── Joint control ──────────────────────────────────────────────────

function applyJointAngles(angles) {
  if (!currentUrdfRobot?.joints) return;

  for (const [name, angle] of Object.entries(angles)) {
    if (typeof angle !== "number") continue;
    jointAngles[name] = angle;
    const joint = currentUrdfRobot.joints[name];
    if (joint) {
      joint.setJointValue(angle);
    }
  }
}

const gripperJawBase = new Map();
let gripperClosedAmt = 0;
let gripperAnimToken = 0;

function gripperLinkObject() {
  return currentUrdfRobot?.links?.link_010
    ?? currentUrdfRobot?.joints?.[jointMap().j6]?.children?.[0]
    ?? null;
}

function collectGripperJaws() {
  const jaws = { a: [], b: [] };
  const link = gripperLinkObject();
  if (!link) return jaws;
  for (const child of link.children) {
    const n = `${child.name || ""} ${child.urdfName || ""}`.toLowerCase();
    if (n.includes("part_019")) jaws.a.push(child);
    else if (n.includes("part_029")) jaws.b.push(child);
  }
  return jaws;
}

function gripperTravelM() {
  const raw = stationConfig?.gripper?.closed;
  if (typeof raw === "number" && raw > 0 && raw <= 0.2) return raw;
  return 0.04;
}

function applyGripperClosedAmount(amount) {
  gripperClosedAmt = amount;
  const dist = gripperTravelM() * amount;
  const apply = (obj, sign) => {
    if (!gripperJawBase.has(obj.uuid)) {
      gripperJawBase.set(obj.uuid, obj.position.clone());
    }
    const base = gripperJawBase.get(obj.uuid);
    obj.position.set(base.x, base.y, base.z + sign * dist);
  };
  const jaws = collectGripperJaws();
  jaws.a.forEach((obj) => apply(obj, -1));
  jaws.b.forEach((obj) => apply(obj, 1));
}

function setGripperVisual(open, durationMs = 280) {
  gripperOpen = !!open;
  updateProcessBar();
  const jaws = collectGripperJaws();
  if (!jaws.a.length && !jaws.b.length) {
    debugPrint("夹爪未找到 part_019/part_029，无法开合");
    return Promise.resolve(false);
  }
  const target = open ? 0 : 1;
  const start = gripperClosedAmt;
  if (Math.abs(target - start) < 1e-6) {
    applyGripperClosedAmount(target);
    return Promise.resolve(true);
  }
  const token = ++gripperAnimToken;
  const t0 = performance.now();
  return new Promise((resolve) => {
    const step = (now) => {
      if (token !== gripperAnimToken) {
        resolve(false);
        return;
      }
      const u = Math.min(1, (now - t0) / Math.max(durationMs, 1));
      const s = u * u * (3 - 2 * u);
      applyGripperClosedAmount(start + (target - start) * s);
      if (u < 1) requestAnimationFrame(step);
      else resolve(true);
    };
    requestAnimationFrame(step);
  });
}

function updateTcpIndicator() {
  if (!tcpIndicator || !tcpLabel || !tcpToggleBtn) return;

  tcpIndicator.classList.toggle("connected", tcpConnected || tcpListening);
  tcpIndicator.classList.toggle("disconnected", !tcpConnected && !tcpListening);

  if (tcpConnected) {
    tcpLabel.textContent = "通讯已连接";
    tcpToggleBtn.textContent = "停止通讯";
  } else if (tcpListening) {
    tcpLabel.textContent = "通讯监听中";
    tcpToggleBtn.textContent = "停止通讯";
  } else {
    tcpLabel.textContent = "通讯未启动";
    tcpToggleBtn.textContent = "启动通讯";
  }
}

function countMovableJoints() {
  const joints = currentUrdfRobot?.joints;
  if (!joints) return 0;
  return Object.values(joints).filter((joint) => joint?.jointType !== "fixed").length;
}

function initJointState() {
  const joints = currentUrdfRobot?.joints;
  if (!joints) return;
  for (const [name, joint] of Object.entries(joints)) {
    if (joint?.jointType === "fixed") continue;
    jointAngles[name] = 0;
  }
}

function updateAxesMode() {
  for (const helper of jointAxesHelpers) {
    helper.parent?.remove(helper);
    helper.geometry?.dispose();
  }
  jointAxesHelpers = [];

  if (!currentModel) return;

  if (axesVisible) {
    currentModel.traverse((child) => {
      if (!child.isMesh) return;
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      mats.forEach((mat) => {
        if (!mat || originalMaterialProps.has(mat.uuid)) return;
        originalMaterialProps.set(mat.uuid, {
          transparent: mat.transparent,
          opacity: mat.opacity,
          depthWrite: mat.depthWrite
        });
        mat.transparent = true;
        mat.opacity = 0.35;
        mat.depthWrite = false;
        mat.needsUpdate = true;
      });
    });

    if (currentUrdfRobot?.joints) {
      for (const joint of Object.values(currentUrdfRobot.joints)) {
        const helper = new THREE.AxesHelper(0.12);
        helper.renderOrder = 999;
        joint.add(helper);
        jointAxesHelpers.push(helper);
      }
    }
  } else {
    currentModel.traverse((child) => {
      if (!child.isMesh) return;
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      mats.forEach((mat) => {
        if (!mat) return;
        const orig = originalMaterialProps.get(mat.uuid);
        if (!orig) return;
        mat.transparent = orig.transparent;
        mat.opacity = orig.opacity;
        mat.depthWrite = orig.depthWrite;
        mat.needsUpdate = true;
      });
    });
    originalMaterialProps.clear();
  }
}

function buildLoadErrorDetails(errorMessage) {
  if (errorMessage.includes("Failed to fetch")) {
    if (lastFailedUrl) {
      return `Load failed: Failed to fetch resource ${lastFailedUrl}`;
    }

    if (loadingSource === "drag-drop") {
      return "Load failed: Failed to fetch. Drag-drop model may reference external textures/buffers; use Open button from the same folder.";
    }

    return "Load failed: Failed to fetch. Resource path is blocked or missing.";
  }

  return `Load failed: ${errorMessage}`;
}
