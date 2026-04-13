import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

// 타입별 가중치 (법안/정책이 가장 강한 신호)
const WEIGHTS = { law: 0.30, patent: 0.25, paper: 0.25, policy: 0.10, news: 0.10 }

// ★ 한 번에 분석할 최대 트렌드 수 (Vercel 60초 제한 대비)
const BATCH_SIZE = 5

function calcTrendScore(evidenceList) {
  const count = { paper: 0, patent: 0, law: 0, policy: 0, news: 0 }
  for (const e of evidenceList) {
    if (count[e.type] !== undefined) count[e.type]++
  }

  // 다국가 교차 신호 보너스
  const countries = new Set(evidenceList.map(e => e.country).filter(Boolean))
  const globalBonus = countries.size >= 3 ? 15 : countries.size >= 2 ? 8 : 0

  let raw = 0
  for (const [type, weight] of Object.entries(WEIGHTS)) {
    raw += Math.min(count[type] * 5, 25) * weight
  }
  return Math.min(Math.round(raw * 4 + globalBonus), 100)
}

function getConfidence(score) {
  if (score >= 70) return 'high'
  if (score >= 40) return 'medium'
  return 'low'
}

async function generateReport(keyword, evidenceList, score) {
  // ★ API 키 체크
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('ANTHROPIC_API_KEY 미설정 — AI 분석 건너뜀')
    return {
      summary: '분석 대기 중 (API 키 미설정)',
      prediction: '',
      sector: '',
      time_horizon: '중기(3년)',
      key_signals: [],
      risk_factors: [],
      countries_leading: []
    }
  }

  const byType = {}
  for (const e of evidenceList) {
    if (!byType[e.type]) byType[e.type] = []
    byType[e.type].push(`[${e.country || 'global'}] ${e.title}${e.summary ? ' — ' + e.summary : ''}`)
  }

  const dataBlock = Object.entries(byType).map(([type, items]) =>
    `[${type.toUpperCase()}]\n${items.slice(0, 5).join('\n')}`
  ).join('\n\n')

  const prompt = `당신은 글로벌 기술 트렌드 전문 분석가입니다.
아래 데이터를 종합해서 "${keyword}" 기술의 투자 전망을 분석해주세요.
트렌드 점수: ${score}/100

${dataBlock}

반드시 아래 JSON 형식으로만 응답하세요 (마크다운 코드블록 없이 순수 JSON):
{
  "summary": "2~3문장 핵심 요약 (한국어)",
  "prediction": "향후 1~3년 전망 및 투자 포인트 (한국어, 3~5문장)",
  "sector": "관련 산업 분야",
  "time_horizon": "단기(1년) 또는 중기(3년) 또는 장기(5년+)",
  "key_signals": ["핵심 신호1", "핵심 신호2", "핵심 신호3"],
  "risk_factors": ["리스크1", "리스크2"],
  "countries_leading": ["주도국가1", "주도국가2"]
}`

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      })
    })

    if (!res.ok) {
      const errBody = await res.text()
      console.error(`Anthropic API HTTP ${res.status}:`, errBody)
      throw new Error(`Anthropic API ${res.status}`)
    }

    const data = await res.json()
    const text = data.content?.[0]?.text || '{}'

    // JSON 파싱 (코드블록 감싸기 대응)
    const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim()
    return JSON.parse(cleaned)
  } catch (e) {
    console.error('AI report error:', e.message)
    return {
      summary: `"${keyword}" 분석 중 오류 발생`,
      prediction: '',
      sector: '',
      time_horizon: '중기(3년)',
      key_signals: [],
      risk_factors: [],
      countries_leading: []
    }
  }
}

export default async function handler(req, res) {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  try {
    // ★ updated_at이 가장 오래된 순서로 BATCH_SIZE개만 처리
    const { data: trends } = await supabase
      .from('trends')
      .select('id, keyword, score')
      .order('updated_at', { ascending: true })
      .limit(BATCH_SIZE)

    if (!trends?.length) {
      return res.status(200).json({ ok: true, message: '분석할 트렌드 없음' })
    }

    let analyzed = 0
    const results = []

    for (const trend of trends) {
      const { data: evidenceList } = await supabase
        .from('evidence')
        .select('*')
        .eq('trend_id', trend.id)
        .order('published_at', { ascending: false })
        .limit(30)

      if (!evidenceList?.length) continue

      const newScore = calcTrendScore(evidenceList)
      const confidence = getConfidence(newScore)

      // ★ weekly_change 계산: 이전 점수와 비교
      const prevScore = trend.score || 0
      const weeklyChange = newScore - prevScore

      await supabase.from('trends').update({
        prev_score: prevScore,
        score: newScore,
        weekly_change: weeklyChange,
        confidence_level: confidence,
        updated_at: new Date().toISOString()
      }).eq('id', trend.id)

      const report = await generateReport(trend.keyword, evidenceList, newScore)

      await supabase.from('reports').upsert({
        trend_id: trend.id,
        summary: report.summary,
        prediction: report.prediction,
        sector: report.sector,
        time_horizon: report.time_horizon,
        evidence_summary: report,
        generated_at: new Date().toISOString()
      }, { onConflict: 'trend_id' })

      results.push({
        keyword: trend.keyword,
        score: newScore,
        change: weeklyChange,
        confidence
      })

      analyzed++
      await new Promise(r => setTimeout(r, 2000))
    }

    res.status(200).json({
      ok: true,
      message: `${analyzed}/${trends.length}개 트렌드 분석 완료 (배치 ${BATCH_SIZE})`,
      details: results
    })
  } catch (e) {
    console.error('analyze handler error:', e)
    res.status(500).json({ error: e.message })
  }
}
