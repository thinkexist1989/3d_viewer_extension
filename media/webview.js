import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { MTLLoader } from "three/addons/loaders/MTLLoader.js";
import URDFLoader from "urdf-loader";
import { ViewportGizmo } from "three-viewport-gizmo";
console.log("webview loaded");
// Use Z-up convention throughout: affects ViewportGizmo coordinate conversions
// and the default up vector for all Object3D instances.
THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

const vscode = acquireVsCodeApi();

const viewerElement = document.getElementById("viewer");
const openButton = document.getElementById("openButton");
const statusElement = document.getElementById("status");
const tcpIndicator = document.getElementById("tcpIndicator");
const tcpLabel = document.getElementById("tcpLabel");
const tcpToggleBtn = document.getElementById("tcpToggle");
const jointPanel = document.getElementById("jointPanel");
const jointList = document.getElementById("jointList");
const dropOverlayElement = document.createElement("div");
dropOverlayElement.className = "drop-overlay";
dropOverlayElement.textContent = "Drop .urdf model here";
viewerElement.appendChild(dropOverlayElement);

const capsuleToolbar = document.createElement("div");
capsuleToolbar.className = "capsule-toolbar";
viewerElement.appendChild(capsuleToolbar);

const axesBtn = document.createElement("button");
axesBtn.className = "capsule-btn";
axesBtn.id = "axesButton";
axesBtn.textContent = "Axes";
capsuleToolbar.appendChild(axesBtn);

const jointsBtn = document.createElement("button");
jointsBtn.className = "capsule-btn";
jointsBtn.id = "jointsButton";
jointsBtn.textContent = "Joints";
capsuleToolbar.appendChild(jointsBtn);

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
let jointPanelVisible = false;
const jointAngles = {};
let jointPanelEntries = []; // [{name, lower, upper, slider, input}]

loader.manager.onError = (url) => {
  lastFailedUrl = String(url ?? "");
  console.error("[Three Model Viewer] Resource load failed:", lastFailedUrl);
};

openButton?.addEventListener("click", () => {
  vscode.postMessage({ type: "requestOpenModel" });
});

axesBtn.addEventListener("click", () => {
  axesVisible = !axesVisible;
  axesBtn.classList.toggle("active", axesVisible);
  updateAxesMode();
});

jointsBtn.addEventListener("click", () => {
  jointPanelVisible = !jointPanelVisible;
  jointsBtn.classList.toggle("active", jointPanelVisible);
  jointPanel.classList.toggle("collapsed", !jointPanelVisible);
  resize();
});

tcpToggleBtn?.addEventListener("click", () => {
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
  setStatus("Release to load URDF");
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
    setStatus(currentModel ? "Model loaded" : "No model loaded");
  }
});

viewerElement.addEventListener("drop", async (event) => {
  event.preventDefault();
  dragDepth = 0;
  viewerElement.classList.remove("drag-active");

  const file = getFirstModelFile(event.dataTransfer?.files);
  if (!file) {
    setStatus("No .urdf file found in drop data");
    return;
  }

  await loadModelFromFile(file);
});

window.addEventListener("resize", () => {
  resize();
});

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

    if (!url) {
      setStatus("Load failed: no model URL provided");
      return;
    }

    setStatus(`Loading ${fileName}...`);

    try {
      urdfLoader.workingPath = workingPath;
      if (packagesPath) {
        urdfLoader.packages = packagesPath;
      }
      const robot = await urdfLoader.loadAsync(url);

      applyLoadedModel(robot);
      currentUrdfRobot = robot;
      updateAxesMode();
      buildJointPanelUI();
      setStatus(`Model loaded: ${sourcePath}`);
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
  setStatus(`Loading ${file.name}...`);

  try {
    if (lowerName.endsWith(".urdf")) {
      const text = await file.text();
      urdfLoader.workingPath = "";
      const robot = urdfLoader.parse(text);
      robot.rotation.x = -Math.PI / 2;
      applyLoadedModel(robot);
      currentUrdfRobot = robot;
      updateAxesMode();
      buildJointPanelUI();
      setStatus(`Model loaded: ${file.name} (external meshes may fail via drag-drop)`);
      return;
    }

    setStatus("Unsupported file type. Use .urdf");
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

function applyJointAngles(angles, fromTcp = false) {
  if (!currentUrdfRobot?.joints) return;

  for (const [name, angle] of Object.entries(angles)) {
    if (typeof angle !== "number") continue;
    jointAngles[name] = angle;
    const joint = currentUrdfRobot.joints[name];
    if (joint) {
      // Use setJointValue to correctly handle revolute (rotation),
      // prismatic (translation), and continuous (unlimited rotation) joints.
      joint.setJointValue(angle);
    }
  }

  // Sync sliders and inputs (skip updates for the source that triggered this)
  for (const entry of jointPanelEntries) {
    const val = jointAngles[entry.name];
    if (val === undefined) continue;
    if (fromTcp) {
      entry.slider.value = String(val);
      entry.input.value = val.toFixed(3);
    }
  }
}

function updateTcpIndicator() {
  if (!tcpIndicator || !tcpLabel || !tcpToggleBtn) return;

  tcpIndicator.classList.toggle("connected", tcpConnected || tcpListening);
  tcpIndicator.classList.toggle("disconnected", !tcpConnected && !tcpListening);

  if (tcpConnected) {
    tcpLabel.textContent = "TCP: Connected";
    tcpToggleBtn.textContent = "Stop TCP";
  } else if (tcpListening) {
    tcpLabel.textContent = "TCP: Listening";
    tcpToggleBtn.textContent = "Stop TCP";
  } else {
    tcpLabel.textContent = "TCP: Off";
    tcpToggleBtn.textContent = "Start TCP";
  }
}

function buildJointPanelUI() {
  jointPanelEntries = [];

  if (!jointList) return;
  jointList.innerHTML = "";

  if (!currentUrdfRobot?.joints) return;

  const jointNames = Object.keys(currentUrdfRobot.joints).sort();

  if (jointNames.length === 0) return;

  for (const name of jointNames) {
    const joint = currentUrdfRobot.joints[name];
    const jointType = joint?.jointType || "revolute";
    const isPrismatic = jointType === "prismatic";
    // For revolute/continuous, default range is ±π; for prismatic, use limits or ±1 meter.
    let lower, upper;
    if (joint?.limit) {
      lower = joint.limit.lower ?? (isPrismatic ? -1 : -Math.PI);
      upper = joint.limit.upper ?? (isPrismatic ? 1 : Math.PI);
    } else {
      lower = isPrismatic ? -1 : -Math.PI;
      upper = isPrismatic ? 1 : Math.PI;
    }
    // If limits are both 0 (placeholder in SolidWorks exports), use defaults.
    if (lower === 0 && upper === 0) {
      lower = isPrismatic ? -1 : -Math.PI;
      upper = isPrismatic ? 1 : Math.PI;
    }
    if (jointType === "continuous") {
      lower = -Math.PI;
      upper = Math.PI;
    }
    if (jointType === "fixed") continue;

    const step = isPrismatic ? "0.001" : "0.01";
    const decimals = 3;

    jointAngles[name] = 0;

    const row = document.createElement("div");
    row.className = "joint-row";

    const label = document.createElement("span");
    label.className = "joint-name";
    label.textContent = `${name} [${jointType}]`;

    const slider = document.createElement("input");
    slider.type = "range";
    slider.className = "joint-slider";
    slider.min = String(lower);
    slider.max = String(upper);
    slider.step = step;
    slider.value = "0";

    const input = document.createElement("input");
    input.type = "number";
    input.className = "joint-input";
    input.min = String(lower);
    input.max = String(upper);
    input.step = step;
    input.value = "0.000";

    slider.addEventListener("input", () => {
      const val = parseFloat(slider.value);
      input.value = val.toFixed(decimals);
      jointAngles[name] = val;
      if (currentUrdfRobot?.joints?.[name]) {
        currentUrdfRobot.joints[name].setJointValue(val);
      }
      vscode.postMessage({ type: "setJointAngles", angles: { [name]: val } });
    });

    input.addEventListener("input", () => {
      let val = parseFloat(input.value);
      if (isNaN(val)) return;
      val = Math.max(lower, Math.min(upper, val));
      slider.value = String(val);
      jointAngles[name] = val;
      if (currentUrdfRobot?.joints?.[name]) {
        currentUrdfRobot.joints[name].setJointValue(val);
      }
      vscode.postMessage({ type: "setJointAngles", angles: { [name]: val } });
    });

    row.appendChild(label);
    row.appendChild(slider);
    row.appendChild(input);
    jointList.appendChild(row);

    jointPanelEntries.push({ name, slider, input });
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
