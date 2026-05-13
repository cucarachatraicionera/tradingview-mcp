import Parser from 'rss-parser';

const parser = new Parser();

const NEWS_SOURCES = [
  { url: 'https://cointelegraph.com/rss', lang: 'en' },
  { url: 'https://coindesk.com/arc/outboundfeeds/rss/', lang: 'en' },
];

const SYMBOL_KEYWORDS = {
  XAUUSD: ['gold', 'xau', 'precious metals', 'gold price', 'fed', 'interest rate'],
  BTCUSD: ['bitcoin', 'btc', 'crypto', 'bitcoin price', 'halving'],
  ETHUSD: ['ethereum', 'eth', 'crypto', 'ethereum price', 'defi'],
  SOLUSD: ['solana', 'sol', 'crypto', 'solana price', 'defi'],
};

const SENTIMENT_KEYWORDS = {
  positive: [
    'surge', 'rally', 'bullish', 'breakout', 'gain', 'upgrade', 'approval',
    'adoption', 'partnership', 'launch', 'positive', 'growth', 'boom',
    '新高', '上涨', '利好', 'approve', 'etf', 'institutional', 'adoption',
    'rate cut', 'stimulus', 'inflation easing', 'hawkish', 'dovish',
  ],
  negative: [
    'crash', 'plunge', 'bearish', 'breakdown', 'loss', 'ban', 'hack',
    'regulatory', 'investigation', 'fraud', 'negative', 'decline', 'fear',
    '暴跌', '下跌', '利空', 'delist', 'exploit', 'sanctions', 'recession',
    'rate hike', 'inflation', 'sell-off', 'liquidation', 'default',
  ],
};

const CACHE = { data: {}, ttl: 10 * 60 * 1000 };

function determineSentiment(title, description) {
  const text = ((title || '') + ' ' + (description || '')).toLowerCase();
  let score = 0;

  for (const word of SENTIMENT_KEYWORDS.positive) {
    if (text.includes(word)) score++;
  }
  for (const word of SENTIMENT_KEYWORDS.negative) {
    if (text.includes(word)) score--;
  }

  if (score > 0) return { sentiment: 'positive', emoji: '🟢', label: 'Positivo' };
  if (score < 0) return { sentiment: 'negative', emoji: '🔴', label: 'Negativo' };
  return { sentiment: 'neutral', emoji: '⚪', label: 'Neutral' };
}

function matchesSymbol(text, symbol) {
  const keywords = SYMBOL_KEYWORDS[symbol] || [symbol.toLowerCase()];
  const lower = text.toLowerCase();
  return keywords.some(k => lower.includes(k));
}

function scoreNews(headline, symbol) {
  const keywords = SYMBOL_KEYWORDS[symbol] || [];
  const lower = headline.toLowerCase();
  let score = 0;
  for (const k of keywords) {
    const words = k.split(' ');
    for (const w of words) {
      if (w.length > 2 && lower.includes(w)) score++;
    }
  }
  // Bonus for exact symbol match
  if (lower.includes(symbol.toLowerCase())) score += 3;
  return score;
}

export async function fetchNews(symbol) {
  const now = Date.now();

  if (CACHE.data[symbol] && (now - CACHE.data[symbol].timestamp) < CACHE.ttl) {
    return CACHE.data[symbol].items;
  }

  const allItems = [];

  for (const source of NEWS_SOURCES) {
    try {
      const feed = await parser.parseURL(source.url);
      for (const item of feed.items || []) {
        const title = item.title || '';
        const description = item.contentSnippet || item.content || '';
        const link = item.link || '';

        if (matchesSymbol(title + ' ' + description, symbol)) {
          const { sentiment, emoji, label } = determineSentiment(title, description);
          allItems.push({
            title,
            url: link,
            sentiment,
            emoji,
            label,
            source: source.url,
            pubDate: item.isoDate || item.pubDate || now,
            score: scoreNews(title, symbol),
          });
        }
      }
    } catch (e) {
      // Source failed, try next
    }
  }

  // Sort by relevance score + recency
  allItems.sort((a, b) => {
    const scoreDiff = b.score - a.score;
    if (scoreDiff !== 0) return scoreDiff;
    return new Date(b.pubDate) - new Date(a.pubDate);
  });

  const top = allItems.slice(0, 5);

  CACHE.data[symbol] = { items: top, timestamp: now };
  return top;
}

// Fallback por si no encuentra noticias reales
export function getFallbackNews(symbol, signalType) {
  const templates = {
    LONG: {
      headlines: [
        `${symbol} muestra fuerte momentum alcista en volumen`,
        `Analistas predicen movimiento alcista para ${symbol}`,
        `${symbol} rompe resistencia clave con soporte de volumen`,
        `Flujo de órdenes positivo detectado en ${symbol}`,
        `${symbol} en zona de sobreventa con posible rebote técnico`,
      ],
      url: `https://www.tradingview.com/symbols/${symbol}/`,
    },
    SHORT: {
      headlines: [
        `${symbol} enfrenta presión bajista por aumento de volatilidad`,
        `Señales de distribución detectadas en ${symbol}`,
        `${symbol} pierde soporte técnico clave`,
        `Participantes del mercado reducen exposición en ${symbol}`,
        `${symbol} muestra debilidad estructural en timeframe superior`,
      ],
      url: `https://www.tradingview.com/symbols/${symbol}/`,
    },
  };

  const tpl = templates[signalType] || templates.LONG;
  const headline = tpl.headlines[Math.floor(Math.random() * tpl.headlines.length)];
  return [{
    title: headline,
    url: tpl.url,
    sentiment: signalType === 'LONG' ? 'positive' : 'negative',
    emoji: signalType === 'LONG' ? '🟢' : '🔴',
    label: signalType === 'LONG' ? 'Positivo' : 'Negativo',
    isFallback: true,
  }];
}

export async function getNewsForSignal(symbol, signalType) {
  try {
    const news = await fetchNews(symbol);
    if (news && news.length > 0) {
      return news;
    }
  } catch (e) {
    // Fall through to fallback
  }
  return getFallbackNews(symbol, signalType);
}
