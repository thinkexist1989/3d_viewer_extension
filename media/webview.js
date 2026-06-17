import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { MTLLoader } from "three/addons/loaders/MTLLoader.js";
import URDFLoader from "urdf-loader";

const vscode = acquireVsCodeApi();

const viewerElement = document.getElementById("viewer");
const openButton = document.getElementById("openButton");
const statusElement = document.getElementById("status");
let modelInfoCollapsed = false;
const dropOverlayElement = document.createElement("div");
dropOverlayElement.className = "drop-overlay";
dropOverlayElement.textContent = "Drop .urdf model here";
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

// --- Gizmo: secondary scene showing world-space XYZ axes in the bottom-left ---
const gizmoSize = 80; // px (CSS pixels)
const gizmoScene = new THREE.Scene();
const gizmoCamera = new THREE.OrthographicCamera(-1.4, 1.4, 1.4, -1.4, 0, 10);
gizmoCamera.position.set(0, 0, 5);
gizmoCamera.lookAt(0, 0, 0);

// Root node that converts ROS Z-up to three.js Y-up:
// rotating -90° around X maps ROS Z (up) → three.js Y (visual up).
const gizmoRoot = new THREE.Object3D();
gizmoRoot.rotation.x = -Math.PI / 2;
gizmoScene.add(gizmoRoot);

// Build labelled axes: X=red, Y=green, Z=blue
(function buildGizmoAxes() {
  const axes = [
    { dir: new THREE.Vector3(1, 0, 0), color: 0xff4444 },
    { dir: new THREE.Vector3(0, 1, 0), color: 0x44dd44 },
    { dir: new THREE.Vector3(0, 0, 1), color: 0x4488ff }
  ];
  for (const { dir, color } of axes) {
    const mat = new THREE.LineBasicMaterial({ color, depthTest: false });
    const pts = [new THREE.Vector3(0, 0, 0), dir.clone()];
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const line = new THREE.Line(geo, mat);
    line.renderOrder = 999;
    gizmoRoot.add(line);
  }
})();

// Sprite-based axis labels
(function buildGizmoLabels() {
  const labels = [
    { text: "X", pos: new THREE.Vector3(1.25, 0, 0), color: "#ff4444" },
    { text: "Y", pos: new THREE.Vector3(0, 1.25, 0), color: "#44dd44" },
    { text: "Z", pos: new THREE.Vector3(0, 0, 1.25), color: "#4488ff" }
  ];
  for (const { text, pos, color } of labels) {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    ctx.font = "bold 48px sans-serif";
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 32, 32);
    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
    const sprite = new THREE.Sprite(mat);
    sprite.position.copy(pos);
    sprite.scale.set(0.4, 0.4, 1);
    sprite.renderOrder = 1000;
    gizmoRoot.add(sprite);
  }
})();

const loader = new GLTFLoader();
const urdfLoader = new URDFLoader();

// Custom mesh loader that extends URDFLoader's defaults to also handle
// .obj, .glb, and .gltf mesh formats referenced from URDF files.
const _defaultMeshLoader = urdfLoader.defaultMeshLoader.bind(urdfLoader);
urdfLoader.loadMeshCb = (meshPath, manager, material, done) => {
  if (/\.obj$/i.test(meshPath)) {
    // Derive sibling .mtl path and resource base from the .obj URL.
    const mtlPath = meshPath.replace(/\.obj$/i, ".mtl");
    const basePath = meshPath.substring(0, meshPath.lastIndexOf("/") + 1);

    const applyObj = (mtlResult) => {
      const objLoader = new OBJLoader(manager);
      if (mtlResult) {
        mtlResult.preload();
        // Blender OBJ exports have Ks 1 1 1 / Ns 255 which over-brightens the model.
        // Clamp specular while keeping the correct Kd diffuse color.
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
      // Set the packages root so that package:// URIs in the URDF resolve correctly.
      // packagesPath is the parent of the URDF’s directory (typically the robot package root).
      if (packagesPath) {
        urdfLoader.packages = packagesPath;
      }
      const robot = await urdfLoader.loadAsync(url);
      // URDF/ROS uses Z-up; three.js uses Y-up. Rotate -90° around X to align.
      robot.rotation.x = -Math.PI / 2;
      applyLoadedModel(robot);
      updateUrdfModelInfo(robot, sourcePath);
      currentUrdfRobot = robot;
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

  // Render gizmo into a small viewport in the bottom-left corner.
  // Sync gizmo camera orientation to the main camera (rotation only).
  gizmoCamera.quaternion.copy(camera.quaternion);

  const dpr = renderer.getPixelRatio();
  const gizmoPx = Math.round(gizmoSize * dpr);
  const totalH = renderer.domElement.height;

  renderer.autoClear = false;
  renderer.setScissorTest(true);
  renderer.setViewport(0, 0, gizmoPx, gizmoPx);
  renderer.setScissor(0, 0, gizmoPx, gizmoPx);
  renderer.clearDepth();
  renderer.render(gizmoScene, gizmoCamera);
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, renderer.domElement.width, totalH);
  renderer.autoClear = true;
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
    if (lowerName.endsWith(".urdf")) {
      const text = await file.text();
      urdfLoader.workingPath = "";
      const robot = urdfLoader.parse(text);
      // URDF/ROS uses Z-up; three.js uses Y-up. Rotate -90° around X to align.
      robot.rotation.x = -Math.PI / 2;
      applyLoadedModel(robot);
      updateUrdfModelInfo(robot, file.name);
      currentUrdfRobot = robot;
      setStatus(`Model loaded: ${file.name} (external meshes may fail via drag-drop)`);
      return;
    }

    setStatus("Unsupported file type. Use .urdf");
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

function applyLoadedModel(sceneObject) {
  if (currentModel) {
    scene.remove(currentModel);
    disposeObject(currentModel);
  }

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
    <div class="info-row"><span>Links</span><span>-</span></div>
    <div class="info-row"><span>Joints</span><span>-</span></div>
    <div class="info-row"><span>Joint Types</span><span>-</span></div>
    <div class="info-row"><span>Vertices</span><span>-</span></div>
    <div class="info-row"><span>Faces</span><span>-</span></div>
    <div class="info-row"><span>Meshes</span><span>-</span></div>
    <div class="info-row"><span>Nodes</span><span>-</span></div>
    <div class="info-row"><span>Materials</span><span>-</span></div>
  `);
}

function updateUrdfModelInfo(robot, sourcePath) {
  const stats = analyzeModel(robot);
  const linkNames = robot.links ? Object.keys(robot.links) : [];
  const jointNames = robot.joints ? Object.keys(robot.joints) : [];
  const jointTypes = {};
  if (robot.joints) {
    for (const joint of Object.values(robot.joints)) {
      const jt = joint.jointType || "unknown";
      jointTypes[jt] = (jointTypes[jt] || 0) + 1;
    }
  }
  const jointTypeSummary = Object.entries(jointTypes)
    .map(([type, count]) => `${type}: ${count}`)
    .join(", ");

  renderModelInfo(`
    <div class="info-row"><span>Path</span><span title="${escapeHtml(sourcePath)}">${escapeHtml(sourcePath)}</span></div>
    <div class="info-row"><span>Links</span><span>${formatNumber(linkNames.length)}</span></div>
    <div class="info-row"><span>Joints</span><span>${formatNumber(jointNames.length)}</span></div>
    <div class="info-row"><span>Joint Types</span><span class="joint-types">${escapeHtml(jointTypeSummary || "—")}</span></div>
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
