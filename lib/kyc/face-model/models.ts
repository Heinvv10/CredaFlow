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
