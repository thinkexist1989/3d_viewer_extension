import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { MTLLoader } from "three/addons/loaders/MTLLoader.js";
import URDFLoader from "urdf-loader";
import { ViewportGizmo } from "three-viewport-gizmo";

// Use Z-up convention throughout: affects ViewportGizmo coordinate conversions
// and the default up vector for all Object3D instances.
THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

const vscode = acquireVsCodeApi();

const viewerElement = document.getElementById("viewer");
const openButton = document.getElementById("openButton");
const statusElement = document.getElementById("status");
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

const scene = new THREE.Scene();
scene.background = new THREE.Color("#10141a");

const camera = new THREE.PerspectiveCamera(
  60,
  Math.max(viewerElement.clientWidth, 1) / Math.max(viewerElement.clientHeight, 1),
  0.1,
  1000
);
camera.position.set(3, -3, 2);
// Z-up: tell the camera its up direction before OrbitControls reads it.
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
// Rotate grid so it lies in the XY plane (Z-up convention).
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
let axesVisible = false;
const originalMaterialProps = new Map();
let jointAxesHelpers = [];

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

      applyLoadedModel(robot);
      currentUrdfRobot = robot;
      updateAxesMode();
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
      // URDF/ROS uses Z-up; three.js uses Y-up. Rotate -90° around X to align.
      robot.rotation.x = -Math.PI / 2;
      applyLoadedModel(robot);
      currentUrdfRobot = robot;
      updateAxesMode();
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

function updateAxesMode() {
  // Remove all existing joint axes helpers.
  for (const helper of jointAxesHelpers) {
    helper.parent?.remove(helper);
    helper.geometry?.dispose();
  }
  jointAxesHelpers = [];

  if (!currentModel) return;

  if (axesVisible) {
    // Make all mesh materials semi-transparent and save originals.
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

    // Add AxesHelper to every joint.
    if (currentUrdfRobot?.joints) {
      for (const joint of Object.values(currentUrdfRobot.joints)) {
        const helper = new THREE.AxesHelper(0.12);
        helper.renderOrder = 999;
        joint.add(helper);
        jointAxesHelpers.push(helper);
      }
    }
  } else {
    // Restore original material properties.
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
