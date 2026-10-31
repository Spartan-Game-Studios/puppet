import { i18n } from '@/lib/i18n';

/*
 * Static export has no middleware, so / is a tiny page that sends the reader
 * to /<lang>/: the first browser language we have, else English. Without JS
 * the <noscript> refresh goes to /en/.
 */
const script = `(function(){var s=${JSON.stringify(i18n.languages)};var l=navigator.languages||[navigator.language||''];var p='${i18n.defaultLanguage}';for(var i=0;i<l.length;i++){var c=(l[i]||'').toLowerCase();var m=s.filter(function(x){var y=x.toLowerCase();return c===y||c.split('-')[0]===y.split('-')[0];})[0];if(m){p=m;break;}}location.replace('/'+p+'/');})();`;

export default function RootRedirect() {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: script }} />
      <noscript>
        <meta httpEquiv="refresh" content={`0; url=/${i18n.defaultLanguage}/`} />
      </noscript>
      <main className="vp-redirect">
        <a href={`/${i18n.defaultLanguage}/`}>VPuppet docs →</a>
        {i18n.languages
          .filter((l) => l !== i18n.defaultLanguage)
          .map((l) => (
            <a key={l} href={`/${l}/`}>
              {l}
            </a>
          ))}
      </main>
    </>
  );
}
