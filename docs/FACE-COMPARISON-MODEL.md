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

0. Prepare one canonical image per side (`lib/kyc/biometric-image.server.ts`):
   a PDF ID rendered once to its first page, EXIF orientation applied and the
   tag dropped, long edge capped at 2048 px (the edge the face model decodes),
   transparency flattened on white, sRGB, JPEG (quality 95, 4:4:4), at most
   8 MiB (a real photograph is about 1-2 MB at the cap; random noise at
   2048x2048 is 8.07 MiB).
   The VLM and the face model receive exactly these bytes; their SHA-256s are
   recorded on the attempt as `comparedImageSha256`. A side that cannot be
   prepared refuses the attempt before either judge runs.
1. Decode each canonical image, long edge at most 2048 px.
2. YuNet on a 640x640 input (the image shrunk to fit, zero-padded bottom and
   right, BGR, raw 0-255): anchor-free decoding over strides 8/16/32,
   score = sqrt(cls x obj) >= 0.9, NMS at IoU 0.3, as `cv::FaceDetectorYN`.
   On the ID side only, when that pass finds no face in an image larger than
   640, YuNet runs once more on the full canonical image (at most 2048 px,
   padded to a multiple of 32), boxes and landmarks in source pixels; the
   evidence records which pass found the ID face (`idDetectPass`: `fit640` or
   `full`). This is what finds the face on an ID card scanned at true size on
   A4. The file declares a fixed 640x640 input, so after the checksum check
   `onnx-shape.ts` rewrites only its declared shapes as symbolic (weights and
   operators untouched; at 640 the outputs are bit-identical). The selfie side
   has no second pass.
3. Face-count rule (below), applied unchanged to whichever pass found faces.
4. Each chosen face must be usable (below), then is aligned to SFace's 112x112
   template with the 5-point similarity transform of
   `cv::FaceRecognizerSF::alignCrop` (ArcFace landmarks), bilinear, zero
   border.
5. SFace embedding (128 values) of each; cosine similarity.
6. Same person iff similarity >= 0.363.

The VLM still runs, in parallel, and all of its v2 gates stay mandatory: the
ID portrait must be a real photograph with a visible face, the selfie a real
live photograph, liveness and both confidences >= 0.7. Its own same-person
answer (`samePerson`, `faceMatch`, `matchConfidence`) is a veto: a VLM
"different" or "uncertain" fails the attempt, and a VLM "same" never rescues
a face-model refusal. Both are required; neither decides alone.

## Usable faces

SFace embeds whatever it is handed, so each compared face must first clear
three model-side floors that do not depend on the VLM (`lib/kyc/face-model/quality.ts`,
floors in `models.ts`). Each is stored in the evidence and re-checked by both
gates; a failure records `extraction_incomplete`.

| Measure | Floor | Presenter card / selfie | Refused below the floor |
|---|---|---|---|
| Eye distance in the image | 24 px | 100.2 / 244.2 | card shrunk to an 80 px photo box: 17.5 |
| Landmark geometry margin (eye-axis tilt under a quarter turn, nose below the eyes, mouth below the nose, mouth corners in eye order; in eye-distances) | 0.15 | 0.404 / 0.519 | collinear, inverted or swapped landmarks: <= 0 |
| Sharpness: variance of the Laplacian of the aligned crop's luma, inside 8 px | 100 | 1115.8 / 1251.5 | grey, beige, zero crops: 0; blurred noise: 65; card blurred at sigma 3: 68 |

What they do not refuse: drawn faces YuNet detects. Six hill-climbed cartoons
measured like real faces (eye distance 97-123 px, geometry 0.35-0.45,
sharpness 860-1552), and SFace scored all 15 cartoon pairs as the same
person (0.373-0.802). Against the real selfie they scored -0.06 to 0.05, so
a drawn face does not match a real one; but a drawn ID compared with a drawn
selfie passes the face model, and only the VLM's illustration and
real-photograph gates refuse it. OpenCV's reference implementation gives the
same scores (below), so this is the model's property, not a preprocessing
fault. Face-free 112x112 crops also score high (noise vs noise 0.808, grey vs
beige 0.884, zero vs zero 1.0); the detector and the sharpness floor keep
them from reaching the comparison.

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
- The breaker's classes (rerun 2026-10-12 on canonical images,
  `face-model-eval/2026-10-12T05-25-47Z/reference-parity.md`): the 15
  hill-climbed cartoon pairs score 0.373-0.802 here and 0.373-0.802 in OpenCV
  (largest difference 0.0019, 15/15 above 0.363 in both); the face-free crop
  pairs agree to four decimals and their embeddings to cosine 1.000000. On
  canonical bytes the presenter pair scores 0.8760 here, 0.8755 in OpenCV.

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

**The face model is not production-safe until impostor pairs of real people,
and printed and blurred classes, have been measured.** What has been measured
does not show it can tell two real people apart: the only real faces tested
are one person's.

- **No impostor similarity between real people has been measured.** YuNet
  found no face on any negative card; the only impostor scores observed are
  between drawn faces (all "same") and between drawn faces and the one real
  selfie (all near 0).
- **The only genuine pair shares its source photo.** The specimen card prints
  the same photograph as the selfie, so 0.8760-0.8776 says nothing about two
  different photos of one person.
- **Printed and blurred real faces are unmeasured** beyond one card blurred
  synthetically (still 0.71-0.83 to the selfie) and the sharpness floor.
- **An ID card scanned on A4 passes with little margin.** At true size the
  face's eye distance is 32 px against the 24 px floor (see above).
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
| ID or selfie cannot be prepared (will not decode, PDF will not render) | `extraction_incomplete` |
| No ID face, two comparable ID faces, more than 64 ID faces | `extraction_incomplete` |
| A compared face too small, not laid out as a face, or too blurred | `extraction_incomplete` |
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
counts, the second-face ratio, each compared face's eye distance, geometry
margin and sharpness, the similarity, the threshold and `samePerson`. Both
gates bound what they accept: an ID face count of 1, or 2-64 with a
second-face ratio in (0, 0.5]; each measure between its floor and a ceiling
no real face reaches. (Without the bounds SQL accepted a count of 1e400,
which Prisma cannot read back.) `assessBiometricEvidence` (TypeScript) and
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

The ID side's full-resolution pass, on a synthetic 1448x2048 page, 8 checks
each: a whole check takes median 254 ms on 1 core, 319 ms on 2, 325 ms
unpinned, against 140 / 162 / 159 ms when the 640 pass finds the face, so
the extra pass costs about 115-165 ms and runs only when the first finds
nothing.

## Why both judges stay

Each catches what the other misses. On canonical bytes (2026-10-12, 3 runs
per cell, `face-model-eval/2026-10-12T05-57-40-009Z/matrix.md`):

| Cell | Outcome | VLM portrait kind / real photo / ID face | VLM samePerson | Face model | Refused by |
|---|---|---|---|---|---|
| Presenter card vs selfie | PASS 3/3 | photograph / true / true | same 3/3 (0.90-0.98) | 1 / 1 faces, cosine 0.8760 | - |
| Silhouette card | FAIL 3/3 | silhouette_placeholder / false / false | same 2/3 | no ID face | VLM and model |
| Silhouette card, no caption | FAIL 3/3 | silhouette_placeholder / false / false | same 2/3 | no ID face | VLM and model |
| Cartoon card | FAIL 3/3 | illustration / false / false | uncertain 3/3 | no ID face | VLM and model |
| Blank card | FAIL 3/3 | silhouette_placeholder / false / false | same 1/3 | no ID face | VLM and model |
| Covered-face card | FAIL 3/3 | photograph / true / true | same 3/3 (0.90) | no ID face | model only |
| Drawn synthetic face card | FAIL 3/3 | illustration / false / false | uncertain 3/3 | no ID face | VLM and model |

Two more cells (2026-10-12, `face-model-eval/2026-10-12T06-34-32-707Z/matrix.md`,
synthetic drawn faces only, vLLM restarts 0 before and after):

| Cell | Outcome | VLM portrait kind / real photo / selfie real | VLM samePerson | Face model | Refused by |
|---|---|---|---|---|---|
| The 15 drawn-vs-drawn pairs YuNet detects (each once) | FAIL 15/15 | illustration / false / false | uncertain 15/15 | PASS 15/15, cosine 0.373-0.802 | VLM only |
| Silhouette card, A4 PDF scan at true size (3 runs) | FAIL 3/3 | silhouette_placeholder / false / true | uncertain 3/3 | no ID face | VLM and model |
| Presenter card, A4 PDF scan at true size (3 runs), before the full-resolution pass | FAIL 3/3 (expected PASS) | photograph / true / true | same 3/3 (0.98) | no ID face | model only |

The VLM's photo-kind judgement holds on a PDF at about 175 DPI after the
2048 px cap. The face model did not, until the ID side's full-resolution
pass (`face-model-eval/2026-10-12T07-07-51-712Z/matrix.md`, restarts 0
before and after):

| Cell | Outcome | VLM portrait kind / real photo / ID face | VLM samePerson | Face model | Refused by |
|---|---|---|---|---|---|
| Presenter card, A4 PDF scan (3 runs) | PASS 3/3 | photograph / true / true | same 3/3 (0.98) | found on the `full` pass: eye distance 32.0 px, geometry 0.428, sharpness 274; cosine 0.8839 | - |
| Silhouette card, A4 PDF scan (3 runs) | FAIL 3/3 | silhouette_placeholder / false / false | uncertain 3/3 | no ID face on either pass | VLM and model |

The A4 face clears the 24 px eye-distance floor by a factor of 1.33 only: a
card scanned smaller than true size, or a page rendered below about 130 DPI,
would be refused as too small.

Why a full-resolution pass and not "trim the page, then the same 640 pass"
(which would leave the model file's declared shapes alone): trimming finds
the card on a clean page (trim threshold 30: 591x372 px, face found) and on
a noisy off-white one (threshold 10 fails, 30 works), and on a certified
copy with the card's back, a stamp and a signature (1158x1397, face found at
scale 0.46). But a certified copy with a scanner header and an address
footer at the page edges trims to 1273x1985, the face stays too small at
640, and it is refused at every threshold tried (10, 30, 60). The
full-resolution pass found the face on all four (eye distance 31.9-32.1 px,
cosine 0.85-0.88 to the selfie). The real-model suite pins that case.

The VLM's same-person answer alone would have passed 5 of the 15
placeholder runs and all 3 covered-face runs; its photograph gates caught
the placeholders and only the face model caught the covered card. The face
model, for its part, calls any two drawn faces it detects the same person,
which only the VLM's illustration and real-photograph gates refuse. The
VLM's same-person veto therefore stays, and so do its photograph gates. On
the genuine pair the VLM refused 0 of 9 runs across the three evaluations.
