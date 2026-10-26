export const GREETING_PATTERN_EN = /^(hi|hello|hey+|yo|good\s*(morning|afternoon|evening|day))\b/i;
export const GREETING_PATTERN_PT = /^(oi|ol[aá]|e\s*a[ií]|bom\s*dia|boa\s*tarde|boa\s*noite|tudo\s*bem|como\s*est[aá]s?)\b/i;
export const GREETING_PATTERN = new RegExp(`(${GREETING_PATTERN_EN.source})|(${GREETING_PATTERN_PT.source})`, 'i');

// PT/EN signal words — no longer used to pick the conversation language
// (that's the customer's explicit choice, see customerService.resolveLocale);
// still used by humanize.service.ts to catch a rewrite in the wrong language.
export const PT_SIGNAL_WORDS = new Set([
  'oi', 'ola', 'olá', 'bom', 'boa', 'dia', 'tarde', 'noite', 'sim', 'nao', 'não',
  'obrigado', 'obrigada', 'favor', 'preciso', 'precisava', 'quero', 'queria', 'gostaria',
  'para', 'meu', 'minha', 'meus', 'minhas', 'carro', 'carros', 'peca', 'peça', 'pecas', 'peças',
  'ainda', 'hoje', 'amanha', 'amanhã', 'entao', 'então', 'voce', 'você', 'tenho', 'esta', 'está',
  'estou', 'sou', 'com', 'sem', 'onde', 'quando', 'porque', 'como', 'isso', 'muito', 'pode',
  'poderia', 'vou', 'fazer', 'comprar', 'preco', 'preço', 'pagar', 'endereco', 'endereço', 'morada',
  'rua', 'bairro', 'numero', 'número', 'tudo', 'bem', 'uma', 'um', 'tambem', 'também', 'mais',
  'menos', 'agora', 'depois', 'ja', 'já', 'aqui', 'ali', 'nome', 'telefone', 'veiculo', 'veículo',
  'motor', 'oleo', 'óleo', 'filtro', 'pastilha', 'pastilhas', 'travao', 'travão', 'correia',
  'amortecedor', 'ajuda', 'ajudar', 'quanto', 'custa', 'obrigadinho', 'certo', 'claro', 'desculpa',
  'desculpe', 'vamos', 'essa', 'esse', 'aquele', 'aquela',
]);

export const EN_SIGNAL_WORDS = new Set([
  'hi', 'hello', 'hey', 'good', 'morning', 'afternoon', 'evening', 'yes', 'please', 'thanks',
  'thank', 'you', 'need', 'needed', 'want', 'wanted', 'would', 'like', 'for', 'my', 'car', 'cars',
  'part', 'parts', 'still', 'today', 'tomorrow', 'then', 'have', 'has', 'with', 'without', 'where',
  'when', 'because', 'how', 'this', 'that', 'very', 'can', 'could', 'will', 'buy', 'price', 'pay',
  'address', 'street', 'name', 'phone', 'vehicle', 'engine', 'oil', 'filter', 'brake', 'pads',
  'belt', 'shock', 'absorber', 'now', 'later', 'here', 'there', 'also', 'more', 'less', 'help',
  'sure', 'sorry', 'okay', 'yeah', 'yep', 'nope', 'much', 'cost', 'many', 'order', 'send', 'photo',
  'picture', 'document',
]);

// Courtesy-message vocabulary for isCourtesyMessage (text only — emoji are ignored). CORE words carry the
// "thanks / okay" meaning; FILLER words only ever pad a courtesy phrase
// ("thank you *so much for the support*", "obrigado *pela ajuda*"). Deliberately
// a plain word list (same no-AI, deterministic approach as the lists above):
// any word outside both sets — a part name, "need", "preciso" — means the
// message is a real request, not a courtesy.
const COURTESY_CORE_WORDS = new Set([
  'ok', 'okay', 'k', 'kk', 'thanks', 'thank', 'thx', 'ty', 'cheers', 'cool', 'great', 'perfect',
  'noted', 'alright', 'fine', 'understood', 'got', 'appreciate', 'appreciated',
  'obrigado', 'obrigada', 'obrigados', 'obrigadas', 'obrigadinho', 'obrigadinha', 'valeu',
  'perfeito', 'certo', 'beleza', 'entendi', 'percebi', 'combinado', 'grato', 'grata', 'tá', 'ta',
]);

const COURTESY_FILLER_WORDS = new Set([
  'you', 'so', 'much', 'very', 'a', 'lot', 'for', 'the', 'your', 'all', 'support', 'help',
  'helping', 'assistance', 'it', 'that', 's', 're', 'anyway', 'again', 'really', 'oh', 'ah',
  'i', 'see', 'understand', 'no', 'problem', 'worries', 'good', 'nice', 'bye', 'goodbye',
  'and', 'kind', 'man', 'sir', 'madam',
  'muito', 'muita', 'pela', 'pelo', 'o', 'ajuda', 'apoio', 'atenção', 'atencao', 'tudo', 'bem',
  'está', 'esta', 'de', 'nada', 'então', 'entao', 'sim', 'mesmo', 'assim', 'boa', 'bom', 'até',
  'ate', 'logo', 'mais', 'e', 'por', 'tchau', 'adeus', 'senhor', 'senhora', 'já', 'ja',
]);

const COURTESY_MAX_WORDS = 12;

/**
 * Checks whether a whole message is only a courtesy — thanks / okay /
 * acknowledgement ("thank you for the support", "ok obrigado pela ajuda")
 * — rather than a request. True when every word is courtesy vocabulary and
 * at least one is a CORE courtesy word; emoji and punctuation are ignored.
 */
export function isCourtesyMessage(text: string): boolean {
  const words = text.trim().toLowerCase().match(/\p{L}+/gu) || [];
  if (!words.length || words.length > COURTESY_MAX_WORDS) return false;

  const allCourtesy = words.every((w) => COURTESY_CORE_WORDS.has(w) || COURTESY_FILLER_WORDS.has(w));
  return allCourtesy && words.some((w) => COURTESY_CORE_WORDS.has(w));
}
