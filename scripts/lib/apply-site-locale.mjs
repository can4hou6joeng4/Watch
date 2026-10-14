import { readFileSync } from 'node:fs';

const chrome = {
  Language: { de: 'Sprache', ko: '언어', 'pt-br': 'Idioma', tr: 'Dil', 'zh-tw': '語言', ja: '言語', fr: 'Langue', es: 'Idioma', ru: 'Язык', it: 'Lingua', vi: 'Ngôn ngữ', id: 'Bahasa' },
  Home: { de: 'Start', ko: '홈', 'pt-br': 'Início', tr: 'Ana sayfa', 'zh-tw': '首頁', ja: 'ホーム', fr: 'Accueil', es: 'Inicio', ru: 'Главная', it: 'Home', vi: 'Trang chủ', id: 'Beranda' },
  'Frequently Asked Questions': { de: 'Häufige Fragen', ko: '자주 묻는 질문', 'pt-br': 'Perguntas frequentes', tr: 'Sık sorulan sorular', 'zh-tw': '常見問題', ja: 'よくある質問', fr: 'Questions fréquentes', es: 'Preguntas frecuentes', ru: 'Частые вопросы', it: 'Domande frequenti', vi: 'Câu hỏi thường gặp', id: 'Pertanyaan umum' },
  'Official Sources & Acceptance Records': { de: 'Offizielle Quellen und Prüfbelege', ko: '공식 출처와 검증 기록', 'pt-br': 'Fontes oficiais e registros de aceitação', tr: 'Resmi kaynaklar ve doğrulama kayıtları', 'zh-tw': '官方來源與驗收記錄', ja: '公式出典と検証記録', fr: 'Sources officielles et preuves de validation', es: 'Fuentes oficiales y registros de aceptación', ru: 'Официальные источники и записи проверки', it: 'Fonti ufficiali e prove di validazione', vi: 'Nguồn chính thức và biên bản nghiệm thu', id: 'Sumber resmi dan catatan penerimaan' },
  'WATCH TECHNICAL GUIDE / SESSION HANDOFF': { de: 'WATCH TECHNISCHER LEITFADEN / SITZUNGSÜBERGABE', ko: 'WATCH 기술 가이드 / 세션 핸드오프', 'pt-br': 'GUIA TÉCNICO WATCH / TRANSFERÊNCIA DE SESSÃO', tr: 'WATCH TEKNİK KILAVUZU / OTURUM DEVİR', 'zh-tw': 'WATCH 技術指南 / 本地接力', ja: 'WATCH 技術ガイド / セッション引き継ぎ', fr: 'GUIDE TECHNIQUE WATCH / RELAIS DE SESSION', es: 'GUÍA TÉCNICA DE WATCH / RELEVO DE SESIÓN', ru: 'ТЕХНИЧЕСКОЕ РУКОВОДСТВО WATCH / ПЕРЕДАЧА СЕАНСА', it: 'GUIDA TECNICA WATCH / PASSAGGIO DI SESSIONE', vi: 'HƯỚNG DẪN KỸ THUẬT WATCH / CHUYỂN PHIÊN', id: 'PANDUAN TEKNIS WATCH / SERAH TERIMA SESI' },
  Published: { de: 'Veröffentlicht', ko: '게시', 'pt-br': 'Publicado', tr: 'Yayın', 'zh-tw': '發布日期', ja: '公開日', fr: 'Publié', es: 'Publicado', ru: 'Опубликовано', it: 'Pubblicato', vi: 'Xuất bản', id: 'Diterbitkan' },
  Modified: { de: 'Aktualisiert', ko: '수정', 'pt-br': 'Atualizado', tr: 'Güncelleme', 'zh-tw': '更新日期', ja: '更新日', fr: 'Modifié', es: 'Actualizado', ru: 'Обновлено', it: 'Aggiornato', vi: 'Cập nhật', id: 'Diperbarui' },
  'Applies to': { de: 'Gilt für', ko: '적용 버전', 'pt-br': 'Aplica-se a', tr: 'Geçerli sürüm', 'zh-tw': '適用版本', ja: '対象バージョン', fr: 'S’applique à', es: 'Aplica a', ru: 'Применимо к', it: 'Si applica a', vi: 'Áp dụng cho', id: 'Berlaku untuk' },
  'Return to Watch Home': { de: 'Zurück zur Watch-Startseite', ko: 'Watch 홈으로', 'pt-br': 'Voltar à página do Watch', tr: 'Watch ana sayfasına dön', 'zh-tw': '返回會話接力首頁', ja: 'Watch のホームへ戻る', fr: 'Retour à l’accueil Watch', es: 'Volver al inicio de Watch', ru: 'На главную Watch', it: 'Torna alla home di Watch', vi: 'Về trang chủ Watch', id: 'Kembali ke beranda Watch' },
  'Download Watch Desktop': { de: 'Watch Desktop laden', ko: 'Watch 데스크톱 받기', 'pt-br': 'Baixar o Watch Desktop', tr: 'Watch Desktop’u indir', 'zh-tw': '下載 Watch 桌面端', ja: 'Watch デスクトップを入手', fr: 'Télécharger Watch Desktop', es: 'Descargar Watch Desktop', ru: 'Скачать Watch Desktop', it: 'Scarica Watch Desktop', vi: 'Tải Watch Desktop', id: 'Unduh Watch Desktop' },
};

const mapString = (value, dictionary, locale) => {
  if (Object.hasOwn(dictionary, value)) return dictionary[value];
  if (chrome[value]?.[locale]) return chrome[value][locale];
  throw new Error(`missing translation for: ${value.slice(0, 80)}`);
};

const mapValue = (value, dictionary, locale) => {
  if (typeof value === 'string') return mapString(value, dictionary, locale);
  if (Array.isArray(value)) return value.map((item) => mapValue(item, dictionary, locale));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapValue(item, dictionary, locale)]));
  }
  return value;
};

export function loadLocaleDictionary(file) {
  const dictionary = JSON.parse(readFileSync(file, 'utf8'));
  if (!dictionary || typeof dictionary !== 'object' || Array.isArray(dictionary)) {
    throw new Error(`translation file is not an object: ${file}`);
  }
  return dictionary;
}

export function translateContent(english, dictionary, locale) {
  return mapValue(english, dictionary, locale);
}

export function translateGuideLocale(englishLocale, dictionary, locale) {
  return mapValue(englishLocale, dictionary, locale);
}
