// ============================================
// ATLAS 기술 키워드 설정 (한국어 메인)
// ============================================

export const TECH_KEYWORDS = [
  { ko: '인공지능', en: 'artificial intelligence', category: '소프트웨어' },
  { ko: '반도체', en: 'semiconductor', category: '하드웨어' },
  { ko: '양자컴퓨팅', en: 'quantum computing', category: '컴퓨팅' },
  { ko: '바이오테크', en: 'biotechnology', category: '바이오' },
  { ko: '자율주행', en: 'autonomous vehicle', category: '모빌리티' },
  { ko: '로봇공학', en: 'robotics', category: '제조/자동화' },
  { ko: '신재생에너지', en: 'renewable energy', category: '에너지' },
  { ko: '블록체인', en: 'blockchain', category: '핀테크' },
  { ko: '핵융합', en: 'nuclear fusion', category: '에너지' },
  { ko: '우주기술', en: 'space technology', category: '항공우주' },
  { ko: '2차전지', en: 'secondary battery', category: '에너지' },
  { ko: '생성형AI', en: 'generative AI', category: '소프트웨어' },
  { ko: '6G통신', en: '6G communication', category: '통신' },
  { ko: '디지털트윈', en: 'digital twin', category: '소프트웨어' },
  { ko: '사이버보안', en: 'cybersecurity', category: '보안' },
  { ko: '스마트팩토리', en: 'smart factory', category: '제조/자동화' },
  { ko: '수소에너지', en: 'hydrogen energy', category: '에너지' },
  { ko: '메타버스', en: 'metaverse', category: '플랫폼' },
  { ko: '클라우드컴퓨팅', en: 'cloud computing', category: '인프라' },
  { ko: '드론', en: 'drone UAV', category: '모빌리티' },
]

// 한국어 → 영어 변환
export function toEn(ko) {
  const found = TECH_KEYWORDS.find(k => k.ko === ko)
  return found ? found.en : ko
}

// 영어 → 한국어 변환
export function toKo(en) {
  const found = TECH_KEYWORDS.find(k => k.en.toLowerCase() === en.toLowerCase())
  return found ? found.ko : en
}

// 카테고리 조회
export function categoryOf(keyword) {
  const found = TECH_KEYWORDS.find(k => k.ko === keyword || k.en.toLowerCase() === keyword.toLowerCase())
  return found ? found.category : 'technology'
}
