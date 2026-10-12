# Face comparison model

The selfie check decides "is the selfie the same person as the ID photo" with
a dedicated face-comparison model, not with the vision-language model (VLM).
Code: `lib/kyc/face-model/`. Evidence tag: `vlm-face-match-v3`.

## Models

Both files come from [opencv/opencv_zoo](https://github.com/opencv/opencv_zoo)
at commit `47534e27c9851bb1128ccc0102f1145e27f23f98`, full precision (not the
int8 variants). They are Git LFS objects, so the download URL is the
`media.githubusercontent.com` form, which returns the binary.

| Role | File | SHA-256 | Licence |
|---|---|---|---|
| Detector (YuNet) | `face_detection_yunet_2023mar.onnx` (232,589 bytes) | `8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4` | [MIT](https://github.com/opencv/opencv_zoo/blob/47534e27c9851bb1128ccc0102f1145e27f23f98/models/face_detection_yunet/LICENSE) |
| Recognizer (SFace) | `face_recognition_sface_2021dec.onnx` (38,696,353 bytes) | `0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79` | [Apache-2.0](https://github.com/opencv/opencv_zoo/blob/47534e27c9851bb1128ccc0102f1145e27f23f98/models/face_recognition_sface/LICENSE) |

- URL: `https://media.githubusercontent.com/media/opencv/opencv_zoo/47534e27c9851bb1128ccc0102f1145e27f23f98/models/face_detection_yunet/face_detection_yunet_2023mar.onnx`
- URL: `https://media.githubusercontent.com/media/opencv/opencv_zoo/47534e27c9851bb1128ccc0102f1145e27f23f98/models/face_recognition_sface/face_recognition_sface_2021dec.onnx`

Runtime: [onnxruntime-node](https://www.npmjs.com/package/onnxruntime-node)
1.30, CPU execution provider only ([MIT](https://github.com/microsoft/onnxruntime/blob/f2c39fe2f838cf35ce7da92824f5a5e3ee6e88a7/LICENSE)).

The licence texts ship beside the models: the fetch script downloads
`LICENSE-face_detection_yunet`, `LICENSE-face_recognition_sface` (from the
same opencv_zoo commit) and `LICENSE-onnxruntime` (from the commit
onnxruntime's v1.30.0 tag points to; the npm package ships none), each
checksum-pinned in `lib/kyc/face-model/models.ts`, and copies
`lib/kyc/face-model/NOTICE` beside them. Neither model directory carries a
NOTICE of its own; the models are used unmodified.

Training data: neither model card states terms for the training data. The
YuNet card reports its accuracy on the WIDER Face validation set and points
to [libfacedetection.train](https://github.com/ShiqiYu/libfacedetection.train)
for training; the SFace card describes MobileFaceNet trained with the SFace
loss and points to the [SFace paper](https://arxiv.org/abs/2205.12010). The
datasets' own terms are not recorded by OpenCV and are not assessed here.

The YuNet card also says it detects "faces of pixels between around 10x10 to
300x300 due to the training scheme". The detector runs on the image shrunk to
fit 640x640, so a selfie whose face fills most of the frame can exceed that
range; it then fails closed as `face_not_detected`.
Image decoding: `sharp` (Apache-2.0). No OpenCV binding, no Python, no paid
service, no GPU.

The weights are not committed. `npm run face-models:fetch` downloads them into
`FACE_MODEL_DIR` (default `./face-models`, gitignored and dockerignored) and
refuses a file whose SHA-256 differs. The app checks the same SHA-256s on the
bytes it hands to the runtime. The Dockerfile fetches them in the build stage;
`next.config.ts` traces them, and the `libonnxruntime.so.1` the native binding
links, into the standalone output. onnxruntime-node's postinstall otherwise
downloads ~270 MB of CUDA providers on linux/x64 that nothing loads: the
project `.npmrc` (`onnxruntime-node-install=skip`) skips them for a local or
CI `npm ci`, and `ONNXRUNTIME_NODE_INSTALL=skip` does the same in the image's
deps stage, which does not copy `.npmrc`.

## Pipeline

1. Decode each image with EXIF orientation applied, transparency flattened on
   white, long edge at most 2048 px. A PDF ID is rendered to its first page by
   the same code that renders it for the VLM.
2. YuNet on a 640x640 input (the image shrunk to fit, zero-padded bottom and
   right, BGR, raw 0-255): anchor-free decoding over strides 8/16/32,
   score = sqrt(cls x obj) >= 0.9, NMS at IoU 0.3, as `cv::FaceDetectorYN`.
3. Face-count rule (below).
4. Align each chosen face to SFace's 112x112 template with the 5-point
   similarity transform of `cv::FaceRecognizerSF::alignCrop` (ArcFace
   landmarks), bilinear, zero border.
5. SFace embedding (128 values) of each; cosine similarity.
6. Same person iff similarity >= 0.363.

The VLM still runs, in parallel, and all of its v2 gates stay mandatory: the
ID portrait must be a real photograph with a visible face, the selfie a real
live photograph, liveness and both confidences >= 0.7. Its own same-person
answer (`samePerson`, `faceMatch`, `matchConfidence`) can only refuse: a VLM
"different" or "uncertain" still fails the attempt, and a VLM "same" never
rescues a face-model refusal.

## Reference parity

Checked once (2026-10-12) against OpenCV 5.0.0's own `FaceDetectorYN` and
`FaceRecognizerSF` on the same ONNX files, over the presenter card and selfie
and the six synthetic cards (scratch script outside the repo; numbers in the
demo data's `face-model-eval/2026-10-12T05-03-09Z/reference-parity.md`):

- Identical 640x640 network input: face counts agree on all 8 images; boxes
  within 0.00002 px, landmarks within 0.00003 px, scores exact. The decoding
  and NMS match the reference.
- Alignment and embedding: OpenCV's `alignCrop` + `feature` on this
  implementation's landmarks gives an embedding at cosine >= 0.99991 to this
  implementation's.
- End to end on the presenter pair: cosine 0.8776 here, 0.8780 from OpenCV
  (difference 0.0004).
- OpenCV at the image's full size (its usual use) differs by up to 4.3% of
  the box width in landmarks and 0.014 in score, from the 640 px downscale,
  and finds no face at all in the full-size 1200x1600 selfie, whose face
  exceeds YuNet's 10-300 px range. Shrinking to fit 640 is what makes it
  detectable.

## Face-count rule

- Selfie: exactly one detected face. None is `face_not_detected`, more is
  `face_count_invalid`.
- ID: one dominant face. With several, the largest is compared only when
  every other detected box is at most 50% of its area (the smart ID card
  prints a small secondary portrait of the holder). Two comparable faces, or
  none, is `extraction_incomplete` (see below for why not
  `id_document_portrait_invalid`).
- The counts and the second face's area ratio are stored in the evidence and
  re-checked by both gates.

## Threshold

0.363 is OpenCV's published cosine threshold for SFace (LFW, 99.60%):
`_threshold_cosine` in opencv_zoo
[`models/face_recognition_sface/sface.py`](https://github.com/opencv/opencv_zoo/blob/47534e27c9851bb1128ccc0102f1145e27f23f98/models/face_recognition_sface/sface.py)
and `cosine_similar_thresh` in OpenCV
[`samples/dnn/face_detect.cpp`](https://github.com/opencv/opencv/blob/4.x/samples/dnn/face_detect.cpp).
It is used unchanged.

Observed (2026-10-12, 3 runs per cell; the model is deterministic, the VLM is not):

| Cell | Detected faces (ID / selfie) | Cosine | Outcome |
|---|---|---|---|
| Presenter specimen card vs presenter selfie | 1 / 1 | 0.8776 (3/3) | PASS 3/3 |
| Silhouette card, with and without caption | 0 / 1 | none | FAIL 6/6 |
| Cartoon card | 0 / 1 | none | FAIL 3/3 |
| Blank card | 0 / 1 | none | FAIL 3/3 |
| Presenter card with the face covered | 0 / 1 | none | FAIL 3/3 |
| Card with a drawn synthetic face | 0 / 1 | none | FAIL 3/3 |

The one genuine pair scored 0.8776, 0.51 above the threshold. See "Open"
below for why that does not confirm the threshold.

## Open

- **No impostor similarity has been measured.** YuNet found no face on any
  negative card, so no pair of different faces ever reached the comparison.
- **The only genuine pair shares its source photo.** The specimen card prints
  the same photograph as the selfie, so 0.8776 says nothing about two
  different photos of one person.
- **The threshold therefore rests on OpenCV's published 0.363 alone**, not on
  observed data. Confirming it needs consented photos of real people: a
  genuine pair from two different photos, and pairs of different people
  (`private/faces/` in the demo data, absent at the time of writing). Until
  then it is not confirmed for production.

## Fails closed

Every one of these refuses the attempt and none falls back to the VLM's
same-person answer:

| Condition | Recorded reason |
|---|---|
| Model file missing, checksum mismatch, runtime will not load | `extraction_incomplete` |
| Inference throws, or the comparison (model load included) exceeds 30 s | `extraction_incomplete` |
| Similarity not a finite number (e.g. a zero embedding) | `extraction_incomplete` |
| Selfie will not decode | `extraction_incomplete` |
| ID will not decode or render, no ID face, two comparable ID faces | `extraction_incomplete` |
| No selfie face / more than one | `face_not_detected` / `face_count_invalid` |
| Similarity below 0.363 | `match_score_below_threshold` |

`extraction_incomplete` is not on the manual-exception allow-list; the others
are, as before. No new borrower-facing copy: each condition maps onto an
existing reason and its approved wording.

The face model never records `id_document_portrait_invalid`. That reason says
the ID carries no real photograph and closes the in-person route over the ID
copy, and only the VLM's affirmative judgement of the portrait may record it
(it is ranked first). A detector miss on the ID is not such a judgement, and
the detector is deterministic, so it would repeat on every retry and strand a
genuine but poorly scanned ID. As `extraction_incomplete` it still refuses
the attempt and cannot be excepted, but staff can complete the in-person
route against the physical ID.

## Evidence (v3)

`biometricResult.faceModel` holds the model names and SHA-256s, both face
counts, the second-face ratio, the similarity, the threshold and
`samePerson`. `assessBiometricEvidence` (TypeScript) and
`subject_has_composite_kyc` / `face_model_evidence_holds` (SQL, migration
`20261011080000_face_match_v3_evidence`) re-prove the pass from those fields
against the pinned constants, on top of every v2 condition, including that
the match was run against the client's newest verified ID copy
(`idDocumentId` / `idDocumentSha256`). Capture compares against the newest
uploaded copy, verified or not; the match counts only once that copy is the
newest verified one. v1 and v2 evidence no longer verifies; the
migration demotes clients VERIFIED only on it to PENDING and un-verifies the
stale selfies, with an audit row each, as the v2 migration did for v1.
Changing a model or the threshold is an evidence change: a new tag and a new
migration (`lib/kyc/face-match-v3-migration.test.ts` fails if the TypeScript
and SQL pins disagree).

## CPU and latency

Measured on the build host (AMD Ryzen 9 9950X), genuine pair, 10 checks
each, with a Docker build running alongside: model load 122-151 ms; one check
(two decodes, two detections, two embeddings) median 147 ms pinned to 1 or 2
cores, 213 ms unpinned; process RSS about 340 MB.

## Open product decision: does the VLM's "different" still refuse?

As built, the VLM's same-person answer can refuse but never pass. In the
evaluation the face model accepted 3 genuine-pair runs and the VLM refused 0
of them, while the VLM answered "same" for 8 of 9 silhouette and blank card
runs and passed all of its gates on the covered-face card in 3 of 3 runs
(the face model refused all of these). Letting only the face model decide
would remove any VLM false refusals of genuine pairs (0 observed so far) at
the cost of dropping the VLM's same-person conditions from both gates.
