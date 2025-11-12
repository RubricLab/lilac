export type LanguageInfo = {
        code: string
        name: string
        introduceYourself: string
}

export const CORE_LANGUAGES: LanguageInfo[] = [
        { code: 'en', name: 'English', introduceYourself: 'Introduce yourself' },
        { code: 'es', name: 'Español', introduceYourself: 'Preséntate' },
        { code: 'zh', name: '中文', introduceYourself: '请自我介绍' },
        { code: 'hi', name: 'हिन्दी', introduceYourself: 'अपना परिचय दीजिए' },
        { code: 'ar', name: 'العربية', introduceYourself: 'قدّم نفسك' },
        { code: 'fr', name: 'Français', introduceYourself: 'Présentez-vous' },
        { code: 'pt', name: 'Português', introduceYourself: 'Apresente-se' },
        { code: 'de', name: 'Deutsch', introduceYourself: 'Stellen Sie sich vor' },
        { code: 'ja', name: '日本語', introduceYourself: '自己紹介をしてください' },
        { code: 'ko', name: '한국어', introduceYourself: '자기소개를 해 주세요' },
        { code: 'it', name: 'Italiano', introduceYourself: 'Presentati' },
        { code: 'ru', name: 'Русский', introduceYourself: 'Представьтесь' },
        { code: 'sw', name: 'Kiswahili', introduceYourself: 'Jitambulishe' },
        { code: 'tr', name: 'Türkçe', introduceYourself: 'Kendinizi tanıtın' }
]

export const LANGUAGE_MAP: Record<string, LanguageInfo> = CORE_LANGUAGES.reduce(
        (acc, language) => {
                acc[language.code] = language
                return acc
        },
        {} as Record<string, LanguageInfo>
)

export function resolveLanguage(code: string | null | undefined): LanguageInfo | undefined {
        if (!code) return undefined
        const normalized = code.toLowerCase().split('-')[0]
        return CORE_LANGUAGES.find(language => language.code === normalized)
}
