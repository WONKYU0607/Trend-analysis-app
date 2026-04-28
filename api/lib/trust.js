// ============================================
// ATLAS v2 — 신뢰도 평가 & 필터링 라이브러리
// ============================================

// ── 뉴스 소스 신뢰도 ──
const NEWS_TRUST = {
  // S급 (0.95) — 공식 통신사/주요 언론
  '연합뉴스': 0.95, 'AP': 0.95, 'Reuters': 0.95, 'Bloomberg': 0.95,
  // A급 (0.85) — 주요 신문/방송
  '조선일보': 0.85, '중앙일보': 0.85, '동아일보': 0.85, '한겨레': 0.85,
  '한국경제': 0.85, '매일경제': 0.85, '서울경제': 0.85, 'KBS': 0.85,
  'MBC': 0.85, 'SBS': 0.85, 'JTBC': 0.85, 'YTN': 0.85,
  // B급 (0.75) — IT 전문지
  '전자신문': 0.75, '디지털타임스': 0.75, 'ZDNet Korea': 0.75,
  '아이티조선': 0.75, '테크크런치': 0.75, 'TechCrunch': 0.75,
  'Wired': 0.75, 'The Verge': 0.75, 'Ars Technica': 0.75,
  'MIT Technology Review': 0.75, 'IEEE Spectrum': 0.75,
  // C급 (0.60) — 일반 미디어
  'default': 0.60
}

// ── 논문 소스 신뢰도 ──
const PAPER_TRUST = {
  // S급 (0.95) — 최고 권위 저널
  'Nature': 0.95, 'Science': 0.95, 'Cell': 0.95, 'NEJM': 0.95,
  'The Lancet': 0.95,
  // A급 (0.85) — 주요 학술지/학회
  'IEEE': 0.85, 'ACM': 0.85, 'ICML': 0.85, 'NeurIPS': 0.85,
  'ICLR': 0.85, 'CVPR': 0.85, 'Nature Machine Intelligence': 0.85,
  'Science Robotics': 0.85,
  // B급 (0.70) — arXiv (peer review 전)
  'arXiv': 0.70, 'OpenAlex': 0.70,
  // C급 (0.60) — RISS 등 (미분류)
  'RISS': 0.65, 'default': 0.60
}

// ── 특허 소스 신뢰도 ──
const PATENT_TRUST = {
  'KIPRIS_등록': 0.95,   // 심사 통과 등록특허
  'KIPRIS_출원': 0.75,   // 출원 중
  'EPO_등록': 0.90,
  'EPO_출원': 0.70,
  'USPTO': 0.85,
  'default': 0.70
}

// ── 법안 신뢰도 ──
const LAW_TRUST = {
  '본회의_통과': 0.98,
  '위원회_통과': 0.85,
  '계류중': 0.65,
  '폐기': 0.10,
  'default': 0.65
}

// ── 키워드별 관련어 사전 ──
export const KEYWORD_DICT = {
  '인공지능':    { must: ['ai', 'artificial intelligence', '인공지능', '머신러닝', '딥러닝', 'llm', 'gpt', '신경망', 'neural', 'chatgpt', 'claude', 'gemini', '언어모델'], boost: ['자동화', '예측', '추론', '학습'] },
  '반도체':      { must: ['반도체', 'semiconductor', 'chip', '칩', 'hbm', '파운드리', 'tsmc', '삼성전자', 'sk하이닉스', 'nand', 'dram', '웨이퍼'], boost: ['fab', '공정', '미세화'] },
  '양자컴퓨팅':  { must: ['양자', 'quantum', 'qubit', '큐비트', 'superposition', 'entanglement'], boost: ['암호화', '시뮬레이션'] },
  '바이오테크':  { must: ['biotech', 'biotechnology', '바이오', 'mrna', '유전자', 'crispr', '신약', 'genomics', '임상'], boost: ['치료제', '백신', '진단'] },
  '자율주행':    { must: ['자율주행', 'autonomous', 'self-driving', '무인', 'lidar', 'tesla', '레벨4', 'adas'], boost: ['센서', '카메라', 'v2x'] },
  '로봇공학':    { must: ['robot', 'robotics', '로봇', '자동화', 'automation', '협동로봇', 'cobot', '휴머노이드'], boost: ['액추에이터', '매니퓰레이터'] },
  '신재생에너지': { must: ['renewable', '신재생', '태양광', '풍력', '에너지전환', 'solar', 'wind', 'ess', '그린에너지'], boost: ['탄소중립', 're100'] },
  '블록체인':    { must: ['blockchain', '블록체인', 'crypto', '암호화폐', 'web3', 'defi', 'nft', 'ethereum', 'bitcoin'], boost: ['스마트컨트랙트', '탈중앙화'] },
  '핵융합':      { must: ['fusion', '핵융합', 'iter', 'plasma', '토카막', 'tokamak', 'nif'], boost: ['플라즈마', '중수소'] },
  '우주기술':    { must: ['space', '우주', '위성', 'rocket', '발사체', 'nasa', 'spacex', '누리호', '위성통신'], boost: ['궤도', '탑재체'] },
  '2차전지':     { must: ['battery', '배터리', '2차전지', '전기차', 'ev', 'lifepo', '리튬', 'ncm', '전고체'], boost: ['충전', '에너지밀도'] },
  '생성형AI':    { must: ['generative', 'generative ai', '생성형', 'gpt', 'llm', 'diffusion', 'stable diffusion', 'midjourney', 'sora'], boost: ['프롬프트', '파인튜닝'] },
  '6G통신':      { must: ['6g', '6g통신', 'terahertz', 'thz', '테라헤르츠', 'itu', '이동통신'], boost: ['mmwave', '빔포밍'] },
  '디지털트윈':  { must: ['digital twin', '디지털트윈', 'simulation', '시뮬레이션', 'metaverse factory', 'cyber physical'], boost: ['iot', '센서'] },
  '사이버보안':  { must: ['cyber', 'security', '사이버보안', '보안', '해킹', 'ransomware', 'malware', 'zero trust', '취약점'], boost: ['암호화', 'firewall'] },
  '스마트팩토리': { must: ['smart factory', '스마트팩토리', '공장자동화', 'iot', 'mes', 'plc', '제조ai'], boost: ['scada', 'opc-ua'] },
  '수소에너지':  { must: ['hydrogen', '수소', '연료전지', 'fuel cell', '그린수소', '수전해'], boost: ['암모니아', '수소차'] },
  '메타버스':    { must: ['metaverse', '메타버스', 'vr', 'ar', 'xr', 'virtual reality', 'augmented reality', 'avatar'], boost: ['게임', '소셜'] },
  '클라우드컴퓨팅': { must: ['cloud', '클라우드', 'aws', 'azure', 'gcp', 'saas', 'paas', 'iaas', 'serverless'], boost: ['마이크로서비스', 'kubernetes'] },
  '드론':        { must: ['drone', '드론', 'uav', '무인기', 'unmanned aerial', 'quadcopter'], boost: ['배송', '촬영', '방위'] },
}

// ── 핵심 필터링 함수 ──
export function trustScore(sourceName, type) {
  const map = { news: NEWS_TRUST, paper: PAPER_TRUST, patent: PATENT_TRUST, law: LAW_TRUST, policy: NEWS_TRUST }
  const table = map[type] || {}
  // 소스명에서 신뢰도 찾기
  for (const [key, score] of Object.entries(table)) {
    if (sourceName?.includes(key)) return score
  }
  return table['default'] || 0.60
}

export function relevanceScore(title, summary, keyword) {
  const dict = KEYWORD_DICT[keyword]
  if (!dict) return 0.5

  const text = `${title} ${summary || ''}`.toLowerCase()
  const { must, boost } = dict

  // 필수 키워드 중 하나라도 포함되어야 함
  const mustMatch = must.filter(k => text.includes(k.toLowerCase()))
  if (mustMatch.length === 0) return 0  // 완전 무관

  // 점수 계산
  const mustScore  = Math.min(mustMatch.length / 2, 1) * 0.7
  const boostMatch = (boost || []).filter(k => text.includes(k.toLowerCase()))
  const boostScore = Math.min(boostMatch.length / 2, 1) * 0.3

  return Math.min(mustScore + boostScore, 1.0)
}

export function shouldInclude(title, summary, sourceName, type, keyword) {
  const rel   = relevanceScore(title, summary, keyword)
  const trust = trustScore(sourceName, type)

  // 관련성 0이면 무조건 제외
  if (rel === 0) return { include: false, score: 0, reason: '관련없음' }

  // 신뢰도 0.5 미만이면 관련성이 높아도 제외
  if (trust < 0.5) return { include: false, score: 0, reason: '신뢰도미달' }

  const final = rel * 0.6 + trust * 0.4
  return { include: final >= 0.45, score: final, reason: 'ok' }
}

// ── 신뢰도 등급 표시 ──
export function trustGrade(score) {
  if (score >= 0.90) return { grade: 'S', color: '#16a34a', label: 'S급' }
  if (score >= 0.80) return { grade: 'A', color: '#1a56db', label: 'A급' }
  if (score >= 0.70) return { grade: 'B', color: '#d97706', label: 'B급' }
  return                    { grade: 'C', color: '#a09d96', label: 'C급' }
}
