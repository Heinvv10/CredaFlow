/**
 * The face-comparison models: which files, from where, with which checksums,
 * and the similarity threshold. Pure constants, shared by the download script,
 * the runtime that loads the files and the evidence gate that re-checks them.
 * docs/FACE-COMPARISON-MODEL.md records the sources, licences and numbers.
 *
 * The files are Git LFS objects in opencv/opencv_zoo; media.githubusercontent
 * serves the binary at a pinned commit (raw.githubusercontent serves the LFS
 * pointer instead).
 */
export const OPENCV_ZOO_COMMIT = "47534e27c9851bb1128ccc0102f1145e27f23f98"

export interface FaceModelFile {
  /** Recorded in the evidence; the file name without its extension. */
  name: string
  file: string
  repoPath: string
  sha256: string
}

export const FACE_MODELS = {
  // YuNet, MIT licence. Full precision, not the int8 variant.
  detector: {
    name: "face_detection_yunet_2023mar",
    file: "face_detection_yunet_2023mar.onnx",
    repoPath: "models/face_detection_yunet/face_detection_yunet_2023mar.onnx",
    sha256: "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
  },
  // SFace, Apache-2.0. Full precision, not the int8 variant.
  recognizer: {
    name: "face_recognition_sface_2021dec",
    file: "face_recognition_sface_2021dec.onnx",
    repoPath: "models/face_recognition_sface/face_recognition_sface_2021dec.onnx",
    sha256: "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79",
  },
} as const satisfies Record<string, FaceModelFile>

/**
 * Licence texts shipped beside the models, with the NOTICE in this directory.
 * Neither opencv_zoo model directory carries a NOTICE file of its own.
 * onnxruntime-node's package ships no LICENSE file, so its text comes from
 * the commit that onnxruntime's v1.30.0 tag points to (the installed version).
 */
export const FACE_MODEL_LICENSES = [
  {
    file: "LICENSE-face_detection_yunet",
    url: `https://raw.githubusercontent.com/opencv/opencv_zoo/${OPENCV_ZOO_COMMIT}/models/face_detection_yunet/LICENSE`,
    sha256: "c83b8120c50ccbd4c4f96edf53141bdd566ebb8f8e9227e415326aa1b1aba958",
  },
  {
    file: "LICENSE-face_recognition_sface",
    url: `https://raw.githubusercontent.com/opencv/opencv_zoo/${OPENCV_ZOO_COMMIT}/models/face_recognition_sface/LICENSE`,
    sha256: "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30",
  },
  {
    file: "LICENSE-onnxruntime",
    url: "https://raw.githubusercontent.com/microsoft/onnxruntime/f2c39fe2f838cf35ce7da92824f5a5e3ee6e88a7/LICENSE",
    sha256: "2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c",
  },
] as const

export function faceModelUrl(model: FaceModelFile): string {
  return `https://media.githubusercontent.com/media/opencv/opencv_zoo/${OPENCV_ZOO_COMMIT}/${model.repoPath}`
}

/**
 * Same person iff the cosine similarity of the two SFace embeddings is at
 * least this. 0.363 is the value OpenCV publishes for SFace on LFW (99.60%):
 * opencv_zoo models/face_recognition_sface/sface.py `_threshold_cosine` and
 * opencv samples/dnn/face_detect.cpp `cosine_similar_thresh`. A change is an
 * evidence change: the SQL gate (migration 20261011080000) pins it too.
 */
export const FACE_SIMILARITY_THRESHOLD = 0.363

/**
 * On the ID, the largest face is used only when every other detected face's
 * box is at most this fraction of its area: the smart ID card prints a small
 * secondary "ghost" portrait of the holder (measured around a tenth of the
 * main photo's area), while two portraits of comparable size mean the
 * document does not say whose face it carries.
 */
export const ID_SECOND_FACE_MAX_AREA_RATIO = 0.5

/** More detected faces than this on an ID is not a document with a portrait. */
export const ID_MAX_FACE_COUNT = 64

/*
 * Floors on each compared face (lib/kyc/face-model/quality.ts), chosen
 * 2026-10-12 from the presenter specimen card / selfie (eye distance 100 /
 * 244 px, geometry margin 0.41 / 0.52, sharpness 1114 / 1241) against what
 * they must refuse: a card shrunk to an 80 px photo box (eyes 17.5 px
 * apart), collinear or inverted landmarks (margin <= 0), flat crops
 * (sharpness 0), blurred noise (64) and a card blurred at sigma 3 (68).
 * SFace's template puts the eyes 35 px apart, so 24 px is at most a 1.5x
 * upsample. The ceilings only bound what a gate accepts: no real face reaches
 * them (the Laplacian of 0-255 luma cannot vary by more than 1020^2).
 */
export const MIN_INTER_OCULAR_PX = 24
export const MAX_INTER_OCULAR_PX = 4096
export const MIN_LANDMARK_GEOMETRY_MARGIN = 0.15
export const MIN_ALIGNED_CROP_SHARPNESS = 100
export const MAX_ALIGNED_CROP_SHARPNESS = 2_000_000
