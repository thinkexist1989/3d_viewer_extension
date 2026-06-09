import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const vscode = acquireVsCodeApi();

const viewerElement = document.getElementById("viewer");
const openButton = document.getElementById("openButton");
const statusElement = document.getElementById("status");
let modelInfoCollapsed = false;
const dropOverlayElement = document.createElement("div");
dropOverlayElement.className = "drop-overlay";
dropOverlayElement.textContent = "Drop .glb / .gltf model here";
viewerElement.appendChild(dropOverlayElement);

const modelInfoElement = document.createElement("div");
modelInfoElement.className = "model-info";
viewerElement.appendChild(modelInfoElement);
resetModelInfo();

const scene = new THREE.Scene();
scene.background = new THREE.Color("#10141a");

const camera = new THREE.PerspectiveCamera(
  60,
  Math.max(viewerElement.clientWidth, 1) / Math.max(viewerElement.clientHeight, 1),
  0.1,
  1000
);
camera.position.set(2, 1.5, 3);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(Math.max(viewerElement.clientWidth, 1), Math.max(viewerElement.clientHeight, 1));
viewerElement.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 0.5, 0);
controls.update();

const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
scene.add(ambientLight);

const directionalLight = new THREE.DirectionalLight(0xffffff, 1.1);
directionalLight.position.set(4, 8, 6);
scene.add(directionalLight);

const grid = new THREE.GridHelper(20, 20, 0x3f3f46, 0x2a2a30);
scene.add(grid);

const loader = new GLTFLoader();
let currentModel = null;
let dragDepth = 0;
let loadingSource = "unknown";
let lastFailedUrl = "";

loader.manager.onError = (url) => {
  lastFailedUrl = String(url ?? "");
  console.error("[Three Model Viewer] Resource load failed:", lastFailedUrl);
};

openButton?.addEventListener("click", () => {
  vscode.postMessage({ type: "requestOpenModel" });
});

viewerElement.addEventListener("dragenter", (event) => {
  event.preventDefault();
  dragDepth += 1;
  viewerElement.classList.add("drag-active");
  setStatus("Release to load model");
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
    setStatus("No .glb/.gltf file found in drop data");
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
  const message = event.data;
  if (message.type === "loadModelUrl") {
    loadingSource = "open-dialog-url";
    lastFailedUrl = "";
    const fileName = typeof message.fileName === "string" ? message.fileName : "model";
    const sourcePath = typeof message.sourcePath === "string" ? message.sourcePath : fileName;
    const url = typeof message.url === "string" ? message.url : "";

    if (!url) {
      setStatus("Load failed: no model URL provided");
      return;
    }

    setStatus(`Loading ${fileName}...`);

    try {
      const gltf = await loadGltfFromUrl(url);
      applyLoadedModel(gltf.scene);
      updateModelInfo(gltf.scene, sourcePath);
      setStatus(`Model loaded: ${fileName}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const details = buildLoadErrorDetails(errorMessage);
      setStatus(details);
      resetModelInfo();
      console.error("[Three Model Viewer] loadModelUrl failed", {
        source: loadingSource,
        fileName,
        url,
        error,
        lastFailedUrl
      });
    }
  }
});

animate();

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

function resize() {
  const width = Math.max(viewerElement.clientWidth, 1);
  const height = Math.max(viewerElement.clientHeight, 1);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height);
}

async function loadModelFromFile(file) {
  lastFailedUrl = "";
  loadingSource = "drag-drop";
  const lowerName = file.name.toLowerCase();
  setStatus(`Loading ${file.name}...`);

  try {
    if (lowerName.endsWith(".glb")) {
      const buffer = await file.arrayBuffer();
      const gltf = await parseGltf(buffer, "");
      applyLoadedModel(gltf.scene);
      updateModelInfo(gltf.scene, file.name);
      setStatus(`Model loaded: ${file.name}`);
      return;
    }

    if (lowerName.endsWith(".gltf")) {
      const text = await file.text();
      const gltf = await parseGltf(text, "");
      applyLoadedModel(gltf.scene);
      updateModelInfo(gltf.scene, file.name);
      setStatus(`Model loaded: ${file.name}`);
      return;
    }

    setStatus("Unsupported file type. Use .glb or .gltf");
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const details = buildLoadErrorDetails(errorMessage);
    setStatus(details);
    resetModelInfo();
    console.error("[Three Model Viewer] loadModelFromFile failed", {
      source: loadingSource,
      fileName: file.name,
      error,
      lastFailedUrl
    });
  }
}

function parseGltf(data, resourcePath) {
  return new Promise((resolve, reject) => {
    loader.parse(data, resourcePath, resolve, reject);
  });
}

function loadGltfFromUrl(url) {
  return new Promise((resolve, reject) => {
    loader.load(url, resolve, undefined, reject);
  });
}

function applyLoadedModel(sceneObject) {
  if (currentModel) {
    scene.remove(currentModel);
    disposeObject(currentModel);
  }

  currentModel = sceneObject;
  scene.add(currentModel);
  frameObject(currentModel);
}

function getFirstModelFile(fileList) {
  if (!fileList || fileList.length === 0) {
    return null;
  }

  for (const file of fileList) {
    const lowerName = file.name.toLowerCase();
    if (lowerName.endsWith(".glb") || lowerName.endsWith(".gltf")) {
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

  camera.position.set(distance, distance * 0.7, distance);
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

function resetModelInfo() {
  renderModelInfo(`
    <div class="info-row"><span>Path</span><span>-</span></div>
    <div class="info-row"><span>Vertices</span><span>-</span></div>
    <div class="info-row"><span>Faces</span><span>-</span></div>
    <div class="info-row"><span>Meshes</span><span>-</span></div>
    <div class="info-row"><span>Nodes</span><span>-</span></div>
    <div class="info-row"><span>Materials</span><span>-</span></div>
  `);
}

function updateModelInfo(sceneObject, sourcePath) {
  const stats = analyzeModel(sceneObject);
  renderModelInfo(`
    <div class="info-row"><span>Path</span><span title="${escapeHtml(sourcePath)}">${escapeHtml(sourcePath)}</span></div>
    <div class="info-row"><span>Vertices</span><span>${formatNumber(stats.vertices)}</span></div>
    <div class="info-row"><span>Faces</span><span>${formatNumber(stats.faces)}</span></div>
    <div class="info-row"><span>Meshes</span><span>${formatNumber(stats.meshes)}</span></div>
    <div class="info-row"><span>Nodes</span><span>${formatNumber(stats.nodes)}</span></div>
    <div class="info-row"><span>Materials</span><span>${formatNumber(stats.materials)}</span></div>
  `);
}

function renderModelInfo(contentHtml) {
  modelInfoElement.classList.toggle("collapsed", modelInfoCollapsed);
  modelInfoElement.innerHTML = `
    <div class="model-info-header">
      <h3>Model Info</h3>
      <button class="model-info-toggle" type="button">${modelInfoCollapsed ? "Show" : "Hide"}</button>
    </div>
    <div class="model-info-body">
      ${contentHtml}
    </div>
  `;

  const toggleButton = modelInfoElement.querySelector(".model-info-toggle");
  toggleButton?.addEventListener("click", () => {
    modelInfoCollapsed = !modelInfoCollapsed;
    renderModelInfo(contentHtml);
  });
}

function analyzeModel(sceneObject) {
  let vertices = 0;
  let faces = 0;
  let meshes = 0;
  let nodes = 0;
  const materialIds = new Set();

  sceneObject.traverse((child) => {
    nodes += 1;

    if (!child.isMesh) {
      return;
    }

    meshes += 1;
    const geometry = child.geometry;
    const position = geometry?.attributes?.position;
    if (position) {
      vertices += position.count;
    }

    if (geometry?.index) {
      faces += Math.floor(geometry.index.count / 3);
    } else if (position) {
      faces += Math.floor(position.count / 3);
    }

    if (Array.isArray(child.material)) {
      child.material.forEach((material) => {
        if (material?.uuid) {
          materialIds.add(material.uuid);
        }
      });
    } else if (child.material?.uuid) {
      materialIds.add(child.material.uuid);
    }
  });

  return {
    vertices,
    faces,
    meshes,
    nodes,
    materials: materialIds.size
  };
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function escapeHtml(input) {
  return String(input)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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
