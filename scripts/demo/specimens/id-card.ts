/**
 * Specimen identity card PNG.
 *
 * Borrows the FIELD LAYOUT of an SA smart ID card (photo left, labelled fields
 * right) because that is what the extraction prompt expects, and nothing
 * else: no coat of arms, no national symbols, no issuing-authority wording, no
 * security artwork. "SPECIMEN — NOT A VALID DOCUMENT" crosses the card.
 *
 * Names are printed in Title Case, NOT the upper case a real card uses. The
 * VLM misreads short upper-case surnames and does so nondeterministically:
 * measured 2026-10-10 on Qwen3-VL-30B, "STEYN" came back "STEVENS" and
 * "BOTHA" came back "BOTH" on some runs, while the Title Case rendering of the
 * same card read correctly every time. The watermark made no difference.
 *
 * Rendered SVG → PNG with sharp (librsvg), using DejaVu Sans from the host's
 * fontconfig.
 *
 * A live-demo card may carry a photograph (the presenter's, so a live selfie
 * genuinely passes the VLM face match). It is cover-fitted into the photo box
 * and drawn UNDER both watermarks: a SPECIMEN band across the photo itself and
 * the card-wide SPECIMEN — NOT A VALID DOCUMENT. Without a photo the box keeps
 * the grey silhouette and "NO PHOTOGRAPH" caption.
 */
import sharp from 'sharp'
import type { Persona } from '../personas/types'
import { parseIsoDate } from './pay-schedule'

export interface IdCardExpectation {
  documentNumber: string
  firstName: string
  surname: string
  dateOfBirth: string
  gender: 'Male' | 'Female'
}

export function idCardExpectation(p: Persona): IdCardExpectation {
  return {
    documentNumber: p.idNumber,
    firstName: p.firstName,
    surname: p.lastName,
    dateOfBirth: p.dateOfBirth,
    gender: p.gender === 'MALE' ? 'Male' : 'Female',
  }
}

const W = 1712
const H = 1080
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'] as const

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function field(x: number, y: number, label: string, value: string): string {
  return `<text x="${x}" y="${y}" class="label">${esc(label)}</text>`
    + `<text x="${x}" y="${y + 48}" class="value">${esc(value)}</text>`
}

/** The photo box, in card pixels. */
const PHOTO = { x: 80, y: 210, w: 440, h: 560 } as const

/** Cover-fits a portrait into the photo box (EXIF orientation applied) as JPEG. */
export async function fitIdPhoto(photo: Buffer): Promise<Buffer> {
  return sharp(photo)
    .rotate()
    .resize(PHOTO.w, PHOTO.h, { fit: 'cover', position: 'centre' })
    .jpeg({ quality: 90 })
    .toBuffer()
}

function photoBox(fittedJpeg: Buffer | undefined): string {
  const frame = `x="${PHOTO.x}" y="${PHOTO.y}" width="${PHOTO.w}" height="${PHOTO.h}"`
  const cx = PHOTO.x + PHOTO.w / 2
  if (!fittedJpeg) {
    return `<rect ${frame} rx="16" fill="#dfe3e1" stroke="#9aa59f" stroke-width="3"/>
  <circle cx="${cx}" cy="420" r="105" fill="#a9b2ad"/>
  <path d="M130 770 C130 600 470 600 470 770 Z" fill="#a9b2ad"/>
  <text x="${cx}" y="815" text-anchor="middle" style="font-size:22px;fill:#5a6a62">NO PHOTOGRAPH — SPECIMEN</text>`
  }
  const href = `data:image/jpeg;base64,${fittedJpeg.toString('base64')}`
  const cy = PHOTO.y + PHOTO.h / 2
  return `<clipPath id="photo-clip"><rect ${frame} rx="16"/></clipPath>
  <image ${frame} preserveAspectRatio="none" clip-path="url(#photo-clip)" href="${href}"/>
  <rect ${frame} rx="16" fill="none" stroke="#9aa59f" stroke-width="3"/>
  <g transform="rotate(-52 ${cx} ${cy})" opacity="0.3">
    <text x="${cx}" y="${cy + 28}" text-anchor="middle" style="font-size:84px;font-weight:bold;fill:#c01818">SPECIMEN</text>
  </g>
  <text x="${cx}" y="815" text-anchor="middle" style="font-size:22px;fill:#5a6a62">SPECIMEN PHOTOGRAPH</text>`
}

/** `fittedPhoto`: a JPEG already sized by fitIdPhoto; omitted → photo-less card. */
export function idCardSvg(p: Persona, fittedPhoto?: Buffer): string {
  const dob = parseIsoDate(p.dateOfBirth)
  const dobPrinted = `${String(dob.day).padStart(2, '0')} ${MONTHS[dob.month - 1]} ${dob.year}`
  const fx = 580
  const fx2 = 1180
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#e8f1ec"/><stop offset="1" stop-color="#f4efdc"/>
    </linearGradient>
    <style>
      text { font-family: 'DejaVu Sans', sans-serif; fill: #1b1b1b; }
      .label { font-size: 26px; fill: #5a6a62; }
      .value { font-size: 42px; font-weight: bold; }
    </style>
  </defs>
  <rect x="0" y="0" width="${W}" height="${H}" rx="48" fill="url(#bg)"/>
  <rect x="0" y="0" width="${W}" height="150" rx="48" fill="#cfe0d6"/>
  <rect x="0" y="100" width="${W}" height="50" fill="#cfe0d6"/>
  <text x="80" y="92" style="font-size:60px;font-weight:bold">IDENTITY CARD</text>
  <text x="${W - 80}" y="70" text-anchor="end" style="font-size:28px;font-weight:bold;fill:#b02020">SPECIMEN</text>
  <text x="${W - 80}" y="110" text-anchor="end" style="font-size:24px;fill:#b02020">DEMONSTRATION ONLY</text>
  ${photoBox(fittedPhoto)}
  ${field(fx, 240, 'Surname', p.lastName)}
  ${field(fx, 360, 'Names', p.firstName)}
  ${field(fx, 480, 'Sex', p.gender === 'MALE' ? 'M' : 'F')}
  ${field(fx2, 480, 'Nationality', 'RSA')}
  ${field(fx, 600, 'Identity Number', p.idNumber)}
  ${field(fx, 720, 'Date of Birth', dobPrinted)}
  ${field(fx2, 720, 'Status', 'CITIZEN')}
  <line x1="${fx}" y1="950" x2="${fx + 520}" y2="950" stroke="#7a857f" stroke-width="2"/>
  <text x="${fx}" y="935" style="font-size:44px;font-style:italic;fill:#2a3a8a">${esc(`${p.firstName[0]}. ${p.lastName}`)}</text>
  <text x="${fx}" y="985" class="label">Signature</text>
  <g transform="rotate(-20 ${W / 2} ${H / 2})" opacity="0.2" style="font-weight:bold;fill:#c01818">
    <text x="${W / 2}" y="${H / 2 - 10}" text-anchor="middle" style="font-size:190px;fill:#c01818">SPECIMEN</text>
    <text x="${W / 2}" y="${H / 2 + 90}" text-anchor="middle" style="font-size:76px;fill:#c01818">NOT A VALID DOCUMENT</text>
  </g>
</svg>`
}

/** `photo`: raw portrait bytes (any format sharp reads); omitted → photo-less card. */
export async function renderIdCard(p: Persona, photo?: Buffer): Promise<Buffer> {
  const fitted = photo ? await fitIdPhoto(photo) : undefined
  return sharp(Buffer.from(idCardSvg(p, fitted))).png({ compressionLevel: 9 }).toBuffer()
}
