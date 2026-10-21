import Script from 'next/script';

// Google Analytics 4 visitor analytics (property tpmjs.com). Sentry is initialized
// once by instrumentation-client.ts. Loaded afterInteractive so it never blocks the
// page; custom funnel events go through `trackEvent` in ~/lib/analytics.
const GA_MEASUREMENT_ID = 'G-710FX54CX1';

export function GoogleAnalytics() {
  return (
    <>
      <Script
        src={`https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`}
        strategy="afterInteractive"
      />
      <Script id="google-analytics" strategy="afterInteractive">
        {`window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
window.gtag = gtag;
gtag('js', new Date());
gtag('config', '${GA_MEASUREMENT_ID}');`}
      </Script>
    </>
  );
}
