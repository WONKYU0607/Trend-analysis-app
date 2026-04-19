import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const WEIGHTS   = { law: 0.30, patent: 0.25, paper: 0.25, policy: 0.10, news: 0.10 }
const BATCH_SIZE  = 3
const API_DELAY   = 15000   // 트렌드 간 15초 (429 방지)
const RETRY_DELAY = 35000   // 429 발생 시 35초 대기
const MAX_RETRY   = 2

const EMPTY_REPORT = {
  headline: '', summary: '', irrelevant_items: [],
  news_highlights: [], paper_highlights: [], law_highlights: [], patent_highlights: [],
  related_companies: [], prediction: '', sector: '', time_horizon: '중기(3년)',
  key_signals: [], risk_factors: [], countries_leading: [], investment_tip: ''
}

// ── 점수 계산 (타입 다양성 + 국가 다양성 + 최신성) ──
function calcTrendScore(evidenceList) {
  if (!evidenceList.length) return 0
  const count = { paper: 0, patent: 0, law: 0, policy: 0, news: 0 }
  for (const e of evidenceList) {
    if (count[e.type] !== undefined) count[e.type]++
  }
  let typeScore = 0
  for (const [type, weight] of Object.entries(WEIGHTS)) {
    typeScore += Math.min(Math.floor(count[type] / 5), 10) * weight * 10
  }
  const countries = new Set(evidenceList.map(e => e.country).filter(Boolean))
  const globalBonus = countries.size >= 5 ? 20 : countries.size >= 3 ? 12 : countries.size >= 2 ? 6 : 0
  const typeCount = Object.values(count).filter(v => v > 0).length
  const diversityBonus = typeCount >= 4 ? 15 : typeCount >= 3 ? 8 : typeCount >= 2 ? 3 : 0
  const now = Date.now()
  const recentCount = evidenceList.filter(e => {
    if (!e.published_at) return false
    return (now - new Date(e.published_at).getTime()) < 30 * 24 * 60 * 60 * 1000
  }).length
  const recencyBonus = recentCount >= evidenceList.length * 0.5 ? 10 : 0
  return Math.min(Math.round(typeScore + globalBonus + diversityBonus + recencyBonus), 100)
}

function getConfidence(score) {
  if (score >= 70) return 'high'
  if (score >= 40) return 'medium'
  return 'low'
}

// ── summary 안전 추출 (Gemini가 다양한 키로 반환하는 경우 대응) ──
function extractSummary(parsed, keyword) {
  const raw = parsed.summary || parsed.핵심요약 || parsed.core_summary || parsed.overview || ''
  if (raw && raw.trim().length > 10) return raw.trim()
  const highlights = [
    ...(parsed.news_highlights   || []),
    ...(parsed.paper_highlights  || []),
    ...(parsed.law_highlights    || []),
    ...(parsed.patent_highlights || [])
  ]
  if (highlights.length >= 2) {
    return highlights.slice(0, 3).map(h => h.insight || h.title || '').filter(Boolean).join('\n')
  }
  return `${keyword} 분야의 최신 동향과 기술 발전 현황을 분석한 결과입니다.`
}

// ── JSON 파싱 (Gemini 실제 개행 버그 대응) ──
function safeParseJSON(text) {
  const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim()
  // 1차: 그대로 파싱
  try { return JSON.parse(cleaned) } catch {}
  // 2차: 문자열 내 실제 개행을 \n으로 교체 후 파싱
  try {
    const fixed = cleaned.replace(/"((?:[^"\\]|\\.)*)"/g,
      (_, val) => '"' + val.replace(/\r?\n/g, '\\n') + '"')
    return JSON.parse(fixed)
  } catch {}
  // 3차: 중괄호 추출 후 같은 처리
  const match = cleaned.match(/\{[\s\S]*\}/)
  if (match) {
    try {
      const fixed = match[0].replace(/"((?:[^"\\]|\\.)*)"/g,
        (_, val) => '"' + val.replace(/\r?\n/g, '\\n') + '"')
      return JSON.parse(fixed)
    } catch {}
  }
  return {}
}

// ── Gemini 호출 (429 재시도 포함) ──
async function callGemini(prompt) {
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.4, maxOutputTokens: 3000 }
        })
      }
    )
    if (res.status === 429) {
      console.warn(`Gemini 429 — ${attempt + 1}/${MAX_RETRY + 1}회, ${RETRY_DELAY / 1000}초 대기`)
      if (attempt < MAX_RETRY) await new Promise(r => setTimeout(r, RETRY_DELAY))
      continue
    }
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Gemini ${res.status}: ${err.slice(0, 200)}`)
    }
    return res
  }
  throw new Error('Gemini 429 재시도 한도 초과')
}

// ── 필터링 + 리포트 단일 Gemini 호출 ──
async function filterAndReport(keyword, evidenceList, score) {
  if (!process.env.GEMINI_API_KEY) {
    return { report: { ...EMPTY_REPORT, summary: 'API 키 미설정' }, filteredEvidence: evidenceList }
  }

  const itemList = evidenceList.map((e, i) => {
    const title   = (e.title   || '').slice(0, 120)
    const summary = (e.summary || '').slice(0, 150)
    return `${i + 1}. [${e.type}][${e.country || 'global'}] ${title}${summary ? ' — ' + summary : ''}`
  }).join('\n')

  const byType   = {}
  for (const e of evidenceList) { if (!byType[e.type]) byType[e.type] = []; byType[e.type].push(e) }
  const hasNews   = (byType.news?.length   || 0) > 0
  const hasPaper  = (byType.paper?.length  || 0) > 0
  const hasLaw    = (byType.law?.length    || 0) > 0 || (byType.policy?.length || 0) > 0
  const hasPatent = (byType.patent?.length || 0) > 0

  const prompt = `당신은 글로벌 기술 트렌드 전문 분석가입니다.
"${keyword}" 키워드로 수집된 근거 자료를 분석하세요. 트렌드 점수: ${score}/100

[작업1] 관련성 필터링
- "${keyword}" 기술과 직접 관련 없는 항목 번호를 irrelevant_items에 넣으세요
- 기준: 키워드가 우연히 포함, 다른 분야, 너무 일반적인 내용

[작업2] 리포트 작성 (관련 있는 자료만 기반)
- 한국어로, 구체적이고 간결하게
- summary는 반드시 2~3문장 이상 작성 (절대 비워두지 말 것)
- 줄바꿈이 필요하면 반드시 \\n 이스케이프 사용 (실제 개행 금지)

수집 데이터:
${itemList}

아래 JSON 형식으로만 응답 (마크다운 없이, 문자열 내 실제 개행 절대 금지):
{"irrelevant_items":[],"headline":"${keyword} 현황 핵심 한 문장","summary":"핵심 동향 2~3문장 (줄바꿈은 \\n만 사용)",${hasNews ? `"news_highlights":[{"title":"15자이내","insight":"왜 중요한지 1줄"},{"title":"핵심2","insight":"1줄"},{"title":"핵심3","insight":"1줄"}],` : '"news_highlights":[],'}${hasPaper ? `"paper_highlights":[{"title":"15자이내","insight":"연구 의미 1줄"},{"title":"핵심2","insight":"1줄"},{"title":"핵심3","insight":"1줄"}],` : '"paper_highlights":[],'}${hasLaw ? `"law_highlights":[{"title":"15자이내","insight":"영향 1줄","country":"KR"},{"title":"핵심2","insight":"1줄","country":"KR"},{"title":"핵심3","insight":"1줄","country":"US"}],` : '"law_highlights":[],'}${hasPatent ? `"patent_highlights":[{"title":"15자이내","insight":"의미 1줄","company":"기업명"},{"title":"핵심2","insight":"1줄","company":"기업"},{"title":"핵심3","insight":"1줄","company":"기업"}],` : '"patent_highlights":[],'},"related_companies":[{"name":"기업명","ticker":"코드또는빈문자열","type":"대기업","role":"역할 1줄","country":"KR"}],"prediction":"향후 1~3년 전망 3~5문장","sector":"산업분야","time_horizon":"단기(1년)/중기(3년)/장기(5년+)","key_signals":["신호1","신호2","신호3"],"risk_factors":["리스크1","리스크2"],"countries_leading":["국가1","국가2"],"investment_tip":"핵심 조언 1~2문장"}`

  try {
    const res  = await callGemini(prompt)
    const data = await res.json()
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}'
    const parsed = safeParseJSON(text)
    const safeSummary = extractSummary(parsed, keyword)
    const report = { ...EMPTY_REPORT, ...parsed, summary: safeSummary }

    // 필터링 DB 반영
    const irrelevantSet = new Set((report.irrelevant_items || []).map(n => n - 1))
    await Promise.all(evidenceList.map((e, i) =>
      supabase.from('evidence').update({
        relevance_score: irrelevantSet.has(i) ? 0 : Math.max(e.relevance_score || 0, 0.8)
      }).eq('id', e.id)
    ))

    const filteredEvidence = evidenceList.filter((_, i) => !irrelevantSet.has(i))
    console.log(`[${keyword}] 필터링 ${evidenceList.length}→${filteredEvidence.length}건 | summary: "${safeSummary.slice(0,40)}..."`)
    return { report, filteredEvidence: filteredEvidence.length ? filteredEvidence : evidenceList }
  } catch (e) {
    console.error(`[${keyword}] AI 오류:`, e.message)
    return {
      report: { ...EMPTY_REPORT, summary: `${keyword} 분야의 최신 기술 동향을 수집하고 있습니다.` },
      filteredEvidence: evidenceList
    }
  }
}

export default async function handler(req, res) {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  try {
    // ★ 리포트 없는 트렌드 우선 처리
    const { data: reportedIds } = await supabase.from('reports').select('trend_id')
    const doneSet = new Set((reportedIds || []).map(r => r.trend_id))

    const { data: allTrends } = await supabase
      .from('trends').select('id, keyword, score, updated_at')
      .order('updated_at', { ascending: true })

    if (!allTrends?.length) return res.status(200).json({ ok: true, message: '트렌드 없음' })

    const unanalyzed = allTrends.filter(t => !doneSet.has(t.id))
    const analyzed   = allTrends.filter(t =>  doneSet.has(t.id))
    const targets    = [...unanalyzed, ...analyzed].slice(0, BATCH_SIZE)

    let done = 0
    const results = []

    for (const trend of targets) {
      const { data: evList } = await supabase
        .from('evidence').select('*')
        .eq('trend_id', trend.id)
        .order('published_at', { ascending: false })
        .limit(30)

      if (!evList?.length) { console.log(`[${trend.keyword}] 근거자료 없음`); continue }

      const { report, filteredEvidence } = await filterAndReport(trend.keyword, evList, trend.score || 0)
      const newScore     = calcTrendScore(filteredEvidence)
      const confidence   = getConfidence(newScore)
      const prevScore    = trend.score || 0
      const weeklyChange = newScore - prevScore

      await supabase.from('trends').update({
        prev_score: prevScore, score: newScore,
        weekly_change: weeklyChange, confidence_level: confidence,
        updated_at: new Date().toISOString()
      }).eq('id', trend.id)

      await supabase.from('reports').upsert({
        trend_id: trend.id, summary: report.summary,
        prediction: report.prediction, sector: report.sector,
        time_horizon: report.time_horizon, evidence_summary: report,
        generated_at: new Date().toISOString()
      }, { onConflict: 'trend_id' })

      results.push({
        keyword: trend.keyword, score: newScore, change: weeklyChange,
        confidence, filtered: `${filteredEvidence.length}/${evList.length}`,
        summary_ok: report.summary.length > 20
      })
      done++
      if (done < targets.length) await new Promise(r => setTimeout(r, API_DELAY))
    }

    res.status(200).json({
      ok: true,
      message: `${done}/${targets.length}개 분석 완료 (배치 ${BATCH_SIZE})`,
      details: results
    })
  } catch (e) {
    console.error('analyze error:', e)
    res.status(500).json({ error: e.message })
  }
}
