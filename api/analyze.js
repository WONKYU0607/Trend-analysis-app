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

  // ── 1. 볼륨 점수 (전체 근거 수, 최대 30점) ──
  const total = evidenceList.length
  const volumeScore = total >= 50 ? 30 : total >= 30 ? 22 : total >= 15 ? 14 : total >= 5 ? 7 : 2

  // ── 2. 최신성 점수 (7일 이내 자료 비율, 최대 25점) ──
  const now = Date.now()
  const veryRecent = evidenceList.filter(e => {
    if (!e.published_at) return false
    return (now - new Date(e.published_at).getTime()) < 7 * 24 * 60 * 60 * 1000
  }).length
  const recent = evidenceList.filter(e => {
    if (!e.published_at) return false
    return (now - new Date(e.published_at).getTime()) < 30 * 24 * 60 * 60 * 1000
  }).length
  const recencyRatio = veryRecent / Math.max(total, 1)
  const recencyScore = recencyRatio >= 0.5 ? 25
    : recencyRatio >= 0.3 ? 18
    : (recent / total) >= 0.5 ? 12
    : (recent / total) >= 0.3 ? 6 : 2

  // ── 3. 국가 다양성 점수 (최대 20점) ──
  const countries = new Set(evidenceList.map(e => e.country).filter(Boolean))
  const geoScore = countries.size >= 5 ? 20 : countries.size >= 4 ? 16
    : countries.size >= 3 ? 11 : countries.size >= 2 ? 6 : 2

  // ── 4. 타입 다양성 점수 (있는 타입 수, 최대 15점) ──
  const typeCount = Object.values(count).filter(v => v > 0).length
  const typeScore = typeCount >= 4 ? 15 : typeCount >= 3 ? 10 : typeCount >= 2 ? 5 : 2

  // ── 5. 고신호 타입 보너스 (법안/특허 있으면 +10) ──
  const highSignalBonus = (count.law + count.policy) >= 2 ? 6
    : (count.law + count.policy) >= 1 ? 3 : 0
  const patentBonus = count.patent >= 3 ? 4 : count.patent >= 1 ? 2 : 0

  const raw = volumeScore + recencyScore + geoScore + typeScore + highSignalBonus + patentBonus
  return Math.min(Math.round(raw), 100)
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

  // 날짜 정보 추출 (최신 자료 날짜 표시용)
  const latestDate = evidenceList
    .filter(e => e.published_at)
    .sort((a, b) => new Date(b.published_at) - new Date(a.published_at))[0]?.published_at
  const latestDateStr = latestDate ? new Date(latestDate).toLocaleDateString('ko-KR') : '최근'

  const prompt = `당신은 한국 최고 수준의 기술 트렌드 애널리스트입니다. 미래에셋증권 리서치센터 수석 연구원처럼 분석하세요.

분석 키워드: "${keyword}" | 수집 자료: ${evidenceList.length}건 | 최신 자료: ${latestDateStr}

━━━ 수집 데이터 ━━━
${itemList}
━━━━━━━━━━━━━━━━━

[작업1] 관련성 필터링
"${keyword}"와 직접 관련 없는 항목 번호를 irrelevant_items에 넣으세요.
기준: 키워드가 우연히 포함된 것, 완전히 다른 분야, 광고성 내용

[작업2] 프리미엄 애널리스트 리포트 작성
반드시 아래 기준을 지키세요:

■ headline: 이번 주 "${keyword}" 시장에서 가장 중요한 변화를 한 문장으로. 반드시 구체적 수치나 기업명 포함.
  좋은 예: "삼성전자 HBM4 3분기 양산 확정, 미국 수출규제 완화 기대감에 국내 반도체 수주 급증"
  나쁜 예: "반도체 기술이 발전하고 있습니다"

■ summary: 투자자/사업자가 지금 당장 알아야 할 핵심 3가지를 번호 없이 서술. 반드시 구체적 수치·기업명·날짜 포함. 일반론 금지. 줄바꿈은 \\n 사용.
  좋은 예: "이번 주 국내 AI 스타트업 투자액이 전분기 대비 34% 증가하며 1.2조원을 돌파했다.\\n특히 의료·금융 분야 AI 규제 샌드박스 확대 법안이 국회 본회의를 통과하면서 B2B AI 솔루션 시장 본격 개화가 예상된다.\\nOpenAI의 GPT-5 출시 이후 국내 기업의 API 도입 문의가 월 3배 급증한 것으로 파악됐다."
  나쁜 예: "생성형AI는 다양한 분야에서 혁신을 주도하고 있습니다"

${hasNews ? `■ news_highlights: 수집된 뉴스 중 가장 임팩트 큰 3건. title은 핵심만 15자 이내, insight는 "왜 지금 중요한가"를 투자자 관점에서 1줄.` : ''}
${hasPaper ? `■ paper_highlights: 수집된 논문 중 산업 파급력 큰 3건. title 15자 이내, insight는 "이 연구가 어떤 사업 기회를 만드는가" 1줄.` : ''}
${hasLaw ? `■ law_highlights: 수집된 법안/정책 중 시장 영향 큰 3건. title 15자 이내, insight는 "이 법안이 통과되면 누가 이득/손해인가" 1줄.` : ''}
${hasPatent ? `■ patent_highlights: 수집된 특허 중 기술 경쟁력 변화를 보여주는 3건. title 15자 이내, insight는 "이 특허가 시장 판도를 어떻게 바꾸는가" 1줄.` : ''}

■ related_companies: 이 기술로 직접 수혜/피해를 받는 기업 5~8개. 한국 상장사 우선, 종목코드 필수 기재. role은 "왜 지금 주목해야 하는가" 구체적으로.

■ prediction: 향후 6개월~3년 시나리오. 낙관/기본/비관 3가지 시나리오로 구분해서 서술. 줄바꿈은 \\n 사용.
  예: "[낙관] 규제 완화 + 수요 급증 시 2026년 시장 규모 15조원 돌파 가능\\n[기본] 현재 성장세 유지 시 연 30% 성장, 2025년 8조원 규모\\n[비관] 글로벌 경기침체 시 투자 위축, 성장률 10% 이하로 둔화"

■ key_signals: 지금 당장 주목해야 할 시장 신호 3가지. 추상적 표현 금지, 구체적 사건/수치로.
  좋은 예: ["삼성 HBM4 양산 3Q 확정", "국회 AI기본법 본회의 통과", "미국 반도체 보조금 2차 신청 시작"]
  나쁜 예: ["기술 발전", "규제 변화", "시장 성장"]

■ risk_factors: 지금 가장 현실적인 리스크 2~3가지. 구체적 사건 기반으로.

■ investment_tip: 지금 이 트렌드에 투자/사업 진입을 고민하는 사람에게 한 줄 조언. 타이밍과 방식 포함.
  좋은 예: "법안 통과 시점(예상 2분기)을 트리거로 의료AI 솔루션 기업 비중 확대 권고, 단 임상 데이터 보유 여부 필수 확인"
  나쁜 예: "관련 기업에 관심을 가져보세요"

아래 JSON으로만 응답 (마크다운 없이, 문자열 내 실제 개행 절대 금지, \\n만 사용):
{"irrelevant_items":[],"headline":"구체적 수치/기업명 포함 한 문장","summary":"구체적 수치·기업명·날짜 포함 3문장 (\\n 구분)",${hasNews ? `"news_highlights":[{"title":"15자이내","insight":"투자자 관점 1줄"},{"title":"핵심2","insight":"1줄"},{"title":"핵심3","insight":"1줄"}],` : '"news_highlights":[],'}${hasPaper ? `"paper_highlights":[{"title":"15자이내","insight":"사업기회 관점 1줄"},{"title":"핵심2","insight":"1줄"},{"title":"핵심3","insight":"1줄"}],` : '"paper_highlights":[],'}${hasLaw ? `"law_highlights":[{"title":"15자이내","insight":"수혜/피해 1줄","country":"KR"},{"title":"핵심2","insight":"1줄","country":"KR"},{"title":"핵심3","insight":"1줄","country":"US"}],` : '"law_highlights":[],'}${hasPatent ? `"patent_highlights":[{"title":"15자이내","insight":"시장판도 변화 1줄","company":"기업명"},{"title":"핵심2","insight":"1줄","company":"기업"},{"title":"핵심3","insight":"1줄","company":"기업"}],` : '"patent_highlights":[],'},"related_companies":[{"name":"기업명","ticker":"종목코드필수","type":"대기업/중견/스타트업","role":"지금 주목해야 하는 이유 1줄","country":"KR"}],"prediction":"[낙관]~\\n[기본]~\\n[비관]~","sector":"구체적 산업분야","time_horizon":"단기(1년)/중기(3년)/장기(5년+)","key_signals":["구체적 사건1","구체적 사건2","구체적 사건3"],"risk_factors":["구체적 리스크1","구체적 리스크2"],"countries_leading":["국가1","국가2"],"investment_tip":"타이밍과 방식 포함 한 줄 조언"}`

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
