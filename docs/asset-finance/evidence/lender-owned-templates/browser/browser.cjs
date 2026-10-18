// Two-lender browser acceptance for lender-owned asset-finance templates.
// Synthetic only. Reads private seed metadata from /tmp/claude-1003/lot-browser.json
// (written by lib/asset-finance/documents/templates/two-lender-browser-seed.test.ts).
// Usage: PORT=<port> IT_CONTAINER=<container> node browser.cjs
const { chromium } = require('/home/hein/Workspace/node_modules/playwright')
const { readFileSync, writeFileSync } = require('fs')
const { createHmac, createHash } = require('crypto')
const { execFileSync } = require('child_process')

const d = JSON.parse(readFileSync('/tmp/claude-1003/lot-browser.json', 'utf8'))
const PORT = process.env.PORT, CONTAINER = process.env.IT_CONTAINER || 'cf-it-lotdemo'
const dir = __dirname
const base = (lender) => `http://${lender}.localhost:${PORT}`
const result = { sourceCommit: process.env.SOURCE_COMMIT || null, frozenTree: true, synthetic: true, checks: [], requests: [], pageErrors: [], shas: {}, dealVersions: {} }

function totp(s) { const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let b = ''; for (const c of s) b += a.indexOf(c).toString(2).padStart(5, '0'); const k = Buffer.from(b.match(/.{8}/g).map((x) => parseInt(x, 2))), n = Buffer.alloc(8); n.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000))); const h = createHmac('sha1', k).update(n).digest(), o = h[19] & 15; return String((h.readUInt32BE(o) & 0x7fffffff) % 1000000).padStart(6, '0') }
// Lookup helper only (ids/hashes the UI does not print in full); never used as proof.
const sql = (q) => execFileSync('docker', ['exec', CONTAINER, 'psql', '-U', 'postgres', '-tAc', q], { encoding: 'utf8' }).trim()
const templateId = (lender, key) => sql(`SELECT id FROM "DocumentTemplate" WHERE "tenantId"='${d[lender].tenantId}' AND key='${key}'`)
const versionRow = (tid, v) => { const [id, sha] = sql(`SELECT id||'|'||"contentSha256" FROM "DocumentTemplateVersion" WHERE "templateId"='${tid}' AND version=${v}`).split('|'); return { id, sha } }
const check = (id, pass, detail) => { result.checks.push({ id, pass: !!pass, detail }); console.log(pass ? 'PASS' : 'FAIL', id, detail ? JSON.stringify(detail).slice(0, 300) : '') }
const pdfText = (file) => execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' })
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

async function step(id, fn) { try { await fn() } catch (e) { check(id, false, { error: String(e.stack || e).slice(0, 1500) }) } }

;(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] })
  const sessions = {}
  async function login(lender, role) {
    const u = d[lender].users[role]
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true })
    const page = await ctx.newPage(); page.setDefaultTimeout(90000)
    page.on('pageerror', (e) => result.pageErrors.push({ who: `${lender}-${role}`, message: e.message }))
    page.on('response', async (r) => {
      const url = new URL(r.url()); const m = r.request().method()
      if (m !== 'GET' && (url.pathname.startsWith('/api/documents/templates') || url.pathname.startsWith('/api/asset-finance/'))) {
        let body = ''; try { body = (await r.text()).slice(0, 600) } catch { body = '<binary or unavailable>' }
        result.requests.push({ who: `${lender}-${role}`, method: m, path: url.pathname, status: r.status(), body: r.headers()['content-type']?.includes('json') ? body : `<${r.headers()['content-type']}>` })
      }
    })
    await page.goto(base(lender) + '/login')
    await page.getByLabel('Email address', { exact: true }).fill(u.email)
    await page.getByLabel('Password', { exact: true }).fill(d.password)
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await page.getByLabel('Verification code', { exact: true }).fill(totp(u.secret))
    await page.getByRole('button', { name: /Verify/ }).click()
    await page.waitForURL(/dashboard/)
    sessions[`${lender}-${role}`] = page
    return page
  }
  const shot = (page, name) => page.screenshot({ path: `${dir}/${name}.png`, fullPage: true })
  const api = async (page, method, path, body) => {
    const r = await page.request.fetch(page.url().split('/').slice(0, 3).join('/') + path, { method, headers: { 'content-type': 'application/json' }, data: body === undefined ? undefined : JSON.stringify(body) })
    const text = await r.text(); let json = null; try { json = JSON.parse(text) } catch {}
    result.requests.push({ who: 'direct-api', method, path, status: r.status(), body: text.slice(0, 600) })
    return { status: r.status(), json, text }
  }

  // Template editor helpers.
  const openEditor = async (page, lender, key) => { const id = templateId(lender, key); await page.goto(`${base(lender)}/settings/documents/${id}/edit`); await page.getByText('Versions', { exact: true }).waitFor(); return id }
  async function approveInUi(page, lender, key, v, shotName, opts) {
    await openEditor(page, lender, key)
    const row = page.getByTestId(`version-${v}`)
    if (opts && opts.shapes) {
      // Preview the version under several deal shapes from the "Preview deal" dropdown first.
      const select = page.getByLabel('Preview deal', { exact: true })
      const options = await select.locator('option').evaluateAll((os) => os.map((o) => ({ value: o.value, label: o.textContent })))
      result.previewShapes = result.previewShapes || {}; result.previewShapes[`${lender}:${key}`] = { options, previewed: [] }
      for (const o of options.slice(0, opts.shapes)) {
        await select.selectOption(o.value)
        const pop = page.context().waitForEvent('page', { timeout: 20000 }).catch(() => null)
        const resp = page.waitForResponse((r) => r.url().endsWith('/preview') && r.request().method() === 'POST')
        await row.getByRole('button', { name: `Preview v${v}`, exact: true }).click()
        const r = await resp; const t = await pop; if (t) await t.close().catch(() => {})
        const reqBody = JSON.parse(r.request().postData() || '{}')
        result.previewShapes[`${lender}:${key}`].previewed.push({ shape: o.value, label: o.label, sentShape: reqBody.shape, status: r.status(), sha: r.headers()['x-template-content-sha256'] })
        if (o === options[1] || options.length === 1) { await select.focus(); await shot(page, opts.shotShapes) }
      }
      await select.selectOption(options[0].value)
    }
    const popup = page.context().waitForEvent('page', { timeout: 20000 }).catch(() => null)
    const previewResp = page.waitForResponse((r) => r.url().endsWith('/preview') && r.request().method() === 'POST')
    await row.getByRole('button', { name: `Preview v${v}`, exact: true }).click()
    const pr = await previewResp; const tab = await popup; if (tab) await tab.close().catch(() => {})
    if (!pr.ok()) throw Error(`preview ${pr.status()}`)
    await row.getByRole('checkbox').check()
    await row.getByText('Demo lender: this records a synthetic demo approval', { exact: false }).waitFor()
    if (shotName) await shot(page, shotName)
    const ar = page.waitForResponse((r) => r.url().endsWith('/approve') && r.request().method() === 'POST')
    await row.getByRole('button', { name: `Approve version ${v}`, exact: true }).click()
    const a = await ar; const body = await a.text()
    if (a.status() !== 200) throw Error(`approve ${a.status()} ${body}`)
    await row.getByText('Synthetic demo approval by', { exact: false }).waitFor()
    return JSON.parse(body)
  }
  async function publishInUi(page, lender, key, v, shotName) {
    await openEditor(page, lender, key)
    const row = page.getByTestId(`version-${v}`)
    const pr = page.waitForResponse((r) => r.url().endsWith('/publish') && r.request().method() === 'POST')
    await row.getByRole('button', { name: `Publish v${v}`, exact: true }).click()
    const p = await pr; if (p.status() !== 200) throw Error(`publish ${p.status()} ${await p.text()}`)
    await row.getByText('Published', { exact: true }).waitFor()
    if (shotName) await shot(page, shotName)
  }
  async function adopt(page, lender, families, shotName) {
    await page.goto(base(lender) + '/settings/documents')
    await page.getByText('Asset-finance legal templates', { exact: true }).waitFor()
    for (const f of families) {
      const li = page.getByTestId(`family-${f}`)
      const r = page.waitForResponse((x) => x.url().includes('/asset-finance/adopt'))
      await li.getByRole('button', { name: 'Adopt starter wording' }).click()
      const resp = await r; if (resp.status() !== 200 && resp.status() !== 201) throw Error(`adopt ${f} ${resp.status()} ${await resp.text()}`)
      await li.getByText('no published version', { exact: false }).first().waitFor()
    }
    if (shotName) await shot(page, shotName)
  }
  async function editAndSave(page, lender, key, edits, shotName) {
    await openEditor(page, lender, key)
    for (const [clause, text] of Object.entries(edits.clauses || {})) await page.locator(`#clause-${clause}`).fill(text)
    for (const term of edits.terms || []) {
      await page.getByRole('button', { name: 'Add a term', exact: true }).click()
      const n = await page.getByLabel(/^Additional term \d+ heading$/).count()
      await page.getByLabel(`Additional term ${n} heading`, { exact: true }).fill(term.heading)
      await page.getByLabel(`Additional term ${n} text`, { exact: true }).fill(term.text)
    }
    await page.locator('#draft-notes').fill(edits.notes)
    const r = page.waitForResponse((x) => /\/versions$/.test(new URL(x.url()).pathname) && x.request().method() === 'POST')
    await page.getByRole('button', { name: 'Save as new draft', exact: true }).click()
    const resp = await r; const body = await resp.text()
    if (shotName) { await page.waitForTimeout(800); await shot(page, shotName) }
    return { status: resp.status(), body }
  }
  async function prepare(page, lender, dealId) {
    await page.goto(`${base(lender)}/asset-finance/deals/${dealId}`)
    const btn = page.getByRole('button', { name: /^Prepare documents( again)?$/ })
    await btn.waitFor()
    const r = page.waitForResponse((x) => x.url().endsWith(`/deals/${dealId}/signing`) && x.request().method() === 'POST')
    await btn.click()
    const resp = await r
    return { status: resp.status(), body: await resp.text() }
  }
  async function downloadAgreement(page, lender, dealId, label) {
    await page.goto(`${base(lender)}/asset-finance/deals/${dealId}`)
    const row = page.locator('tr', { hasText: 'Asset finance agreement' }).first()
    await row.waitFor()
    const meta = (await row.locator('td').first().innerText()).replace(/\s+/g, ' ')
    const dl = page.waitForEvent('download')
    await row.getByRole('link', { name: 'Download', exact: true }).click()
    const download = await dl
    const file = `/tmp/claude-1003/lot-pdfs/${label}.pdf`
    await download.saveAs(file)
    const buf = readFileSync(file)
    const text = pdfText(file)
    writeFileSync(`${dir}/${label}.txt`, text)
    const sha = sha256(buf)
    const wm = JSON.parse(execFileSync('npx', ['tsx', `${dir}/watermark-pages.ts`, file], { cwd: '/home/hein/Workspace/CredaFlow-lot', encoding: 'utf8' }).trim())
    result.shas[label] = { sha256: sha, bytes: buf.length, panel: meta, watermarkPerPage: wm }
    return { buf, text, sha, meta, wm }
  }
  const flat2 = (t) => t.replace(/\s+/g, ' ')
  const pages = (text) => text.split('\f').filter((p) => p.trim())
  const everyPageWatermarked = (wm) => Array.isArray(wm) && wm.length > 0 && wm.every(Boolean)

  const A = d.alpha, B = d.bravo
  const aAuthor = await login('alpha', 'author'), aApprover = await login('alpha', 'approver'), aOfficer = await login('alpha', 'officer')
  const bAuthor = await login('bravo', 'author'), bApprover = await login('bravo', 'approver'), bOfficer = await login('bravo', 'officer')
  check('logins.password+totp', true, 'six staff sessions via /login with password then TOTP')

  // 1. Bravo before adopting anything.
  await step('1.bravo-refused-before-adoption', async () => {
    const r = await prepare(bOfficer, 'bravo', B.deals.commercial1)
    await bOfficer.getByText(/template has not been adopted/).first().waitFor({ timeout: 15000 }).catch(() => {})
    await shot(bOfficer, '01-bravo-prepare-refused-not-adopted')
    check('1.bravo-refused-before-adoption', r.status === 422 && /template has not been adopted/.test(r.body), r)
  })

  // 2. Alpha author adopts, edits, gets refused for money/override wording, saves.
  const ALPHA_INSURANCE = 'ALPHA insurance wording: from delivery until ownership passes, the Purchaser must keep the Goods comprehensively insured for their full value as new with a registered insurer acceptable to the Seller, with the Seller noted as owner and first loss payee, and must deliver the renewed policy schedule to the Seller within seven days after each renewal.'
  const ALPHA_TERM = { heading: 'ALPHA site visits', text: 'ALPHA: The Purchaser allows the Seller or its appointed representative to inspect the Goods at their site on reasonable notice during business hours.' }
  await step('2.alpha-adopt', async () => {
    await adopt(aAuthor, 'alpha', ['af.isa', 'af.resolution', 'af.suretyship', 'af.nca'], '02-alpha-families-adopted')
    check('2.alpha-adopt', ['af.isa.commercial', 'af.isa.cpa', 'af.resolution.standard', 'af.suretyship.commercial', 'af.nca.finance_lease'].every((k) => templateId('alpha', k)))
  })
  await step('2.alpha-bad-wording-refused', async () => {
    const r = await editAndSave(aAuthor, 'alpha', 'af.isa.commercial', {
      clauses: { insurance: ALPHA_INSURANCE },
      terms: [ALPHA_TERM, { heading: 'Administration', text: 'An administration fee of R 500 is payable notwithstanding anything else in this Agreement.' }],
      notes: 'ALPHA wording with a forbidden term',
    }, '03-alpha-save-refused-money-and-override')
    const alerts = await aAuthor.getByRole('alert').allInnerTexts()
    result.refusalAlerts = alerts
    check('2.alpha-bad-wording-refused', r.status === 422 && alerts.length > 0, { status: r.status, body: r.body.slice(0, 500), alerts })
    // Remove the forbidden term and save the ALPHA wording.
    await aAuthor.getByRole('button', { name: 'Remove', exact: true }).nth(1).click()
    await aAuthor.locator('#draft-notes').fill('ALPHA insurance wording and ALPHA site visits term')
    const rr = aAuthor.waitForResponse((x) => /\/versions$/.test(new URL(x.url()).pathname) && x.request().method() === 'POST')
    await aAuthor.getByRole('button', { name: 'Save as new draft', exact: true }).click()
    const ok = await rr; const body = await ok.text()
    await aAuthor.getByTestId('version-2').waitFor()
    await shot(aAuthor, '04-alpha-author-v2-draft-no-approve-control')
    const v2 = aAuthor.getByTestId('version-2')
    const noApprove = (await v2.getByRole('button', { name: /^Approve/ }).count()) === 0 && (await v2.getByText('Awaiting approval by another admin.').count()) === 1
    check('2.alpha-v2-saved', ok.status() === 201 || ok.status() === 200, { status: ok.status(), body })
    check('2.author-sees-no-approve-control', noApprove)
  })
  const aIsa = templateId('alpha', 'af.isa.commercial')
  await step('2.author-api-approve-409', async () => {
    const v = versionRow(aIsa, 2)
    const r = await api(aAuthor, 'POST', `/api/documents/templates/${aIsa}/versions/${v.id}/approve`, { contentSha256: v.sha, attestation: true })
    check('2.author-api-approve-409', r.status === 409 && /Cannot approve your own draft/.test(r.text), r)
  })

  await step('2.starter-isa-commercial-v1-previewable', async () => {
    const v1 = versionRow(aIsa, 1)
    const r = await api(aApprover, 'POST', `/api/documents/templates/${aIsa}/preview`, { versionId: v1.id })
    check('2.starter-isa-commercial-v1-previewable', r.status === 200, { status: r.status, body: r.status === 200 ? '<pdf>' : r.text.slice(0, 500) })
  })

  // 3. Approver previews and approves; approver cannot publish; author publishes.
  await step('3.alpha-approve-v2', async () => {
    const a = await approveInUi(aApprover, 'alpha', 'af.isa.commercial', 2, '05-alpha-approver-synthetic-demo-notice', { shapes: 3, shotShapes: '05a-alpha-approver-preview-deal-shapes' })
    const ps = result.previewShapes['alpha:af.isa.commercial']
    check('3.approver-previewed-two-or-more-deal-shapes', ps.previewed.length >= 2 && ps.previewed.every((x) => x.status === 200 && x.sentShape === x.shape) && new Set(ps.previewed.map((x) => x.shape)).size === ps.previewed.length, ps)
    await shot(aApprover, '06-alpha-approver-approved-v2')
    check('3.alpha-approve-v2-synthetic-demo', a.approvalBasis === 'SYNTHETIC_DEMO', a)
    const ui = await aApprover.getByTestId('version-2').getByRole('button', { name: 'Publish v2' }).count()
    check('3.approver-sees-no-publish-control', ui === 0)
    const v = versionRow(aIsa, 2)
    const r = await api(aApprover, 'POST', `/api/documents/templates/${aIsa}/versions/${v.id}/publish`, {})
    check('3.approver-api-publish-409', r.status === 409 && /approver cannot also publish/i.test(r.text), r)
    await publishInUi(aAuthor, 'alpha', 'af.isa.commercial', 2, '07-alpha-author-published-v2')
    check('3.alpha-author-published-v2', true)
  })
  await step('3.alpha-other-variants', async () => {
    for (const key of ['af.isa.cpa', 'af.resolution.standard', 'af.suretyship.commercial', 'af.nca.finance_lease']) {
      await approveInUi(aApprover, 'alpha', key, 1)
      await publishInUi(aAuthor, 'alpha', key, 1)
    }
    await aAuthor.goto(base('alpha') + '/settings/documents'); await aAuthor.getByText('Asset-finance legal templates').waitFor()
    await shot(aAuthor, '08-alpha-families-published')
    check('3.alpha-other-variants-published', true)
  })

  // 4. Bravo, different wording; cross-lender 404.
  const BRAVO_CESSION = 'BRAVO cession wording: the Seller may cede, assign or pledge its rights under this Agreement to any funder and tells the Purchaser in writing when it does. The Purchaser may not cede, assign or transfer any right or obligation under this Agreement, or part with possession of the Goods, without the prior written consent of the Seller.'
  const BRAVO_TERM = { heading: 'BRAVO equipment logbook', text: 'BRAVO: The Purchaser keeps a logbook of the working hours and location of the Goods and gives the Seller a copy on request.' }
  await step('4.bravo-templates', async () => {
    await adopt(bAuthor, 'bravo', ['af.isa', 'af.resolution', 'af.suretyship', 'af.lease.operating'], '09-bravo-families-adopted')
    const r = await editAndSave(bAuthor, 'bravo', 'af.isa.commercial', { clauses: { cession: BRAVO_CESSION }, terms: [BRAVO_TERM], notes: 'BRAVO cession wording and BRAVO logbook term' }, '10-bravo-author-v2-draft')
    check('4.bravo-v2-saved', r.status === 201 || r.status === 200, r)
    await approveInUi(bApprover, 'bravo', 'af.isa.commercial', 2, '11-bravo-approver-synthetic-demo-notice')
    await publishInUi(bAuthor, 'bravo', 'af.isa.commercial', 2, '12-bravo-author-published-v2')
    for (const key of ['af.resolution.standard', 'af.suretyship.commercial', 'af.lease.operating.cpa']) {
      await approveInUi(bApprover, 'bravo', key, 1)
      await publishInUi(bAuthor, 'bravo', key, 1)
    }
    check('4.bravo-published', true)
  })
  await step('4.cross-lender-404', async () => {
    const bIsa = templateId('bravo', 'af.isa.commercial')
    const g = await api(aAuthor, 'GET', `/api/documents/templates/${bIsa}`)
    const v = versionRow(bIsa, 2)
    const p = await api(aApprover, 'POST', `/api/documents/templates/${bIsa}/versions/${v.id}/approve`, { contentSha256: v.sha, attestation: true })
    await aAuthor.goto(`${base('alpha')}/settings/documents/${bIsa}/edit`)
    await aAuthor.waitForLoadState('networkidle').catch(() => {})
    await shot(aAuthor, '13-alpha-session-bravo-template-editor')
    const editorStatus = (await aAuthor.getByText('BRAVO', { exact: false }).count()) === 0
    check('4.cross-lender-get-404', g.status === 404, g)
    check('4.cross-lender-approve-404', p.status === 404, p)
    check('4.cross-lender-editor-shows-no-bravo-wording', editorStatus, { url: aAuthor.url() })
  })

  // 5. Officers prepare and download.
  const docs = [
    ['alpha', aOfficer, 'commercial1', 'alpha-commercial1-agreement'],
    ['alpha', aOfficer, 'cpaIsa', 'alpha-cpa-isa-agreement'],
    ['alpha', aOfficer, 'ncaFinanceLease', 'alpha-nca-finance-lease-agreement'],
    ['bravo', bOfficer, 'commercial1', 'bravo-commercial1-agreement'],
    ['bravo', bOfficer, 'cpaOperatingLease', 'bravo-cpa-operating-lease-agreement'],
  ]
  let shotNo = 14
  const texts = {}
  for (const [lender, page, deal, label] of docs) {
    await step(`5.${label}`, async () => {
      const dealId = d[lender].deals[deal]
      if (!dealId) { check(`5.${label}`, false, 'deal not seeded'); return }
      const r = await prepare(page, lender, dealId)
      if (r.status !== 200) { await shot(page, `${shotNo++}-${label}-prepare-failed`); check(`5.${label}.prepare`, false, r); return }
      await page.getByText('Template version', { exact: false }).first().waitFor()
      const banner = await page.getByText('Issued from a synthetic demo approval', { exact: false }).count()
      await shot(page, `${shotNo++}-${label}-prepared`)
      const doc = await downloadAgreement(page, lender, dealId, label)
      texts[label] = doc.text
      result.dealVersions[label] = doc.meta
      check(`5.${label}.prepare`, r.status === 200, { status: r.status })
      check(`5.${label}.panel-synthetic-demo`, banner === 1 && /\(synthetic demo\)/.test(doc.meta), doc.meta)
      check(`5.${label}.watermark-every-page`, everyPageWatermarked(doc.wm), { watermarkPerPage: doc.wm })
    })
  }
  const has = (label, s) => (texts[label] || '').includes(s)
  const flat = (label) => (texts[label] || '').replace(/\s+/g, ' ')
  const MARKERS = ['ALPHA insurance wording', 'ALPHA site visits', 'ALPHA-V3', 'BRAVO cession wording', 'BRAVO equipment logbook']
  const noLenderText = (label) => MARKERS.every((m) => !flat(label).includes(m))
  await step('5.content', async () => {
    const ac = 'alpha-commercial1-agreement', bc = 'bravo-commercial1-agreement'
    check('5.alpha-commercial.identity', has(ac, 'Synthetic Alpha Asset Finance (Pty) Ltd') && !has(ac, 'Synthetic Bravo Equipment Credit'))
    check('5.alpha-commercial.own-wording', flat(ac).includes('ALPHA insurance wording') && flat(ac).includes('ALPHA site visits') && !flat(ac).includes('BRAVO cession wording') && !flat(ac).includes('BRAVO equipment logbook'))
    check('5.alpha-commercial.protected-7.3', /7\.3\s+Payment/.test(texts[ac] || ''), 'expects "7.3 Payment" heading')
    check('5.bravo-commercial.identity', has(bc, 'Synthetic Bravo Equipment Credit (Pty) Ltd') && !has(bc, 'Synthetic Alpha Asset Finance'))
    check('5.bravo-commercial.own-wording', flat(bc).includes('BRAVO cession wording') && flat(bc).includes('BRAVO equipment logbook') && !flat(bc).includes('ALPHA insurance wording') && !flat(bc).includes('ALPHA site visits'))
    check('5.bravo-commercial.protected-7.3', /7\.3\s+Payment/.test(texts[bc] || ''))
    const cpa = 'alpha-cpa-isa-agreement'
    check('5.alpha-cpa-isa.s49-notice', has(cpa, 'NOTICE UNDER SECTION 49'))
    check('5.alpha-cpa-isa.no-commercial-lender-text', noLenderText(cpa) && has(cpa, 'Synthetic Alpha Asset Finance (Pty) Ltd'))
    const lease = 'bravo-cpa-operating-lease-agreement'
    check('5.bravo-cpa-lease.identity', has(lease, 'Synthetic Bravo Equipment Credit (Pty) Ltd') && !has(lease, 'Synthetic Alpha') && noLenderText(lease))
    check('5.bravo-cpa-lease.s49-initials', /section 49/i.test(texts[lease] || '') && /initial/i.test(texts[lease] || ''))
    const nca = 'alpha-nca-finance-lease-agreement'
    check('5.alpha-nca.identity-and-headings', has(nca, 'Synthetic Alpha Asset Finance (Pty) Ltd') && /National Credit Act/i.test(texts[nca] || '') && noLenderText(nca))
  })

  // 6. Version three.
  await step('6.alpha-v3', async () => {
    const r = await editAndSave(aAuthor, 'alpha', 'af.isa.commercial', { terms: [{ heading: 'ALPHA-V3 operator training', text: 'ALPHA-V3: The Purchaser ensures that only trained and competent operators use the Goods.' }], notes: 'ALPHA-V3 operator training term' })
    check('6.alpha-v3-saved', r.status === 201 || r.status === 200, r)
    await approveInUi(aApprover, 'alpha', 'af.isa.commercial', 3)
    await publishInUi(aAuthor, 'alpha', 'af.isa.commercial', 3, `${shotNo++}-alpha-v3-published-v2-archived`)
    const v2Row = aAuthor.getByTestId('version-2')
    check('6.v2-archived-in-history', (await v2Row.getByText('Archived', { exact: true }).count()) === 1)
    // The archived version is still readable: the UI preview button, then the same preview fetched directly for its text.
    const prUi = aAuthor.waitForResponse((x) => x.url().endsWith('/preview') && x.request().method() === 'POST')
    const popup = aAuthor.context().waitForEvent('page', { timeout: 20000 }).catch(() => null)
    await v2Row.getByRole('button', { name: 'Preview v2', exact: true }).click()
    const p = await prUi; const tab = await popup; if (tab) await tab.close().catch(() => {})
    const v2 = versionRow(aIsa, 2)
    const direct = await aAuthor.request.post(`${base('alpha')}/api/documents/templates/${aIsa}/preview`, { headers: { 'content-type': 'application/json' }, data: JSON.stringify({ versionId: v2.id }) })
    result.requests.push({ who: 'direct-api', method: 'POST', path: `/api/documents/templates/${aIsa}/preview (archived v2)`, status: direct.status(), body: direct.headers()['content-type'] })
    writeFileSync('/tmp/claude-1003/lot-pdfs/alpha-archived-v2-preview.pdf', await direct.body())
    const t = pdfText('/tmp/claude-1003/lot-pdfs/alpha-archived-v2-preview.pdf'); writeFileSync(`${dir}/alpha-archived-v2-preview.txt`, t)
    check('6.archived-v2-preview-readable', p.status() === 200 && direct.status() === 200 && t.replace(/\s+/g, ' ').includes('ALPHA site visits') && !t.includes('ALPHA-V3'), { ui: p.status(), direct: direct.status() })
  })
  await step('6.second-deal-v3', async () => {
    const r = await prepare(aOfficer, 'alpha', A.deals.commercial2)
    await aOfficer.getByText('Template version', { exact: false }).first().waitFor()
    await shot(aOfficer, `${shotNo++}-alpha-commercial2-prepared-v3`)
    const doc = await downloadAgreement(aOfficer, 'alpha', A.deals.commercial2, 'alpha-commercial2-agreement-v3')
    check('6.second-deal-prepared', r.status === 200, { status: r.status })
    check('6.second-deal-shows-v3', /Template version 3/.test(doc.meta) && doc.text.replace(/\s+/g, ' ').includes('ALPHA-V3 operator training'), doc.meta)
    check('6.second-deal-watermark-every-page', everyPageWatermarked(doc.wm), { watermarkPerPage: doc.wm })
  })
  await step('6.first-deal-unchanged', async () => {
    const before = result.shas['alpha-commercial1-agreement']
    const doc = await downloadAgreement(aOfficer, 'alpha', A.deals.commercial1, 'alpha-commercial1-agreement-redownload')
    await shot(aOfficer, `${shotNo++}-alpha-commercial1-still-v2`)
    check('6.first-deal-bytes-identical', before && doc.sha === before.sha256, { before: before && before.sha256, after: doc.sha })
    check('6.first-deal-no-v3-text', !flat2(doc.text).includes('ALPHA-V3') && flat2(doc.text).includes('ALPHA site visits') && /Template version 2/.test(doc.meta), doc.meta)
  })

  result.pageErrorsCount = result.pageErrors.length
  writeFileSync(`${dir}/result.json`, JSON.stringify(result, null, 2))
  await browser.close()
  const failed = result.checks.filter((c) => !c.pass)
  console.log(`\n${result.checks.length - failed.length}/${result.checks.length} checks passed`)
  process.exit(failed.length ? 1 : 0)
})().catch((e) => { console.error(e.stack); writeFileSync(`${dir}/result.json`, JSON.stringify({ ...result, fatal: String(e.stack) }, null, 2)); process.exit(2) })
