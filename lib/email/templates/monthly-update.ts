export const getSubject = () => "TLDW is now Little universe + My favorite videos from 2025";

export const getHtmlBody = (unsubscribeUrl: string) => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      line-height: 1.6;
      color: #333;
      max-width: 600px;
      margin: 0 auto;
      padding: 20px;
    }
    .header {
      margin-bottom: 30px;
      text-align: center;
    }
    .content {
      background: #ffffff;
      padding: 20px;
      border-radius: 8px;
    }
    .footer {
      margin-top: 30px;
      text-align: center;
      font-size: 12px;
      color: #888;
    }
    a {
      color: #4F46E5;
      text-decoration: none;
    }
    h1 {
      font-size: 24px;
      font-weight: bold;
      color: #111;
      margin-bottom: 20px;
    }
    p {
      margin-bottom: 16px;
    }
    ol {
      margin-bottom: 20px;
      padding-left: 20px;
    }
    ol li {
      margin-bottom: 12px;
    }
    .button {
      display: inline-block;
      background-color: #4F46E5;
      color: white;
      padding: 12px 24px;
      border-radius: 6px;
      font-weight: bold;
      margin: 20px 0;
    }
  </style>
</head>
<body>
  <div class="content">
    <p>Hey!</p>

    <p>This is Zara, one of the people behind TLDW. First, a big announcement: we renamed it to <a href="https://www.longcut.ai/">Little universe</a>. Our new tagline is "Don't take the shortcut in your learning; take the longcut." We felt like the new name reflects our philosophy better. Plus, there were way too many products called TLDW.</p>

    <p>I wanted to share some features we've shipped recently based on your feedback:</p>

    <p><strong>Multilingual videos & translation</strong>: You asked, we delivered. Little universe now parses transcripts for videos in any language (as long as there are subtitles on YouTube). You can also translate transcripts and view them side by side, which is great for language learning.</p>

    <p style="text-align: center; margin: 20px 0;">
      <img src="https://longcut.ai/newsletter-multilingual.png" alt="Multilingual videos and transcript translation feature" style="max-width: 100%; height: auto; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
    </p>

    <p><strong>Click-to-jump transcripts</strong>: Click any line in the transcript to jump straight to that moment. You can also search for keywords and hop around the video instantly.</p>

    <p><strong>Clean up messy transcripts</strong>: YouTube's auto-captions are... not great. Now you can remove filler words and fix transcription errors with one click, then save them as clean notes.</p>

    <p><strong>Export transcripts</strong>: Download as .txt, .srt, or .csv… whatever works for you.</p>

    <p><strong>Generate infographics</strong>: Turn key takeaways into shareable images with Nano Banana Pro (See a demo <a href="https://x.com/zarazhangrui/status/1994109755330347389?s=20">here</a>).</p>

    <p><strong>Flexible payment</strong>: We added a credit-based pay-as-you-go option if you don't want a subscription.</p>

    <p>I also wanted to share my 5 favorite video podcasts from 2025 (all parsed on Little universe if you want to check them out):</p>

    <ol>
      <li><a href="https://www.longcut.ai/v/going-direct-lulu-cheng-meservey-ep-25-GRoU1T4E9rQ?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DGRoU1T4E9rQ">Helping Founders Go Direct in a New Era of PR & Comms with Lulu Cheng Meservey</a> (Uncapped with Jack Altman)</li>
      <li><a href="https://www.longcut.ai/v/high-school-dropout-to-openai-researcher-gabriel-petersson-interview-extraordina-vq5WhoPCWQ8?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dvq5WhoPCWQ8">High School Dropout to OpenAI Researcher - Gabriel Petersson Interview</a> (Extraordinary)</li>
      <li><a href="https://www.longcut.ai/v/a-conversation-with-jony-ive-wLb9g_8r-mE?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DwLb9g_8r-mE">A conversation with Jony Ive</a> (Stripe)</li>
      <li><a href="https://www.longcut.ai/v/chris-pedregal-sam-stephenson-making-meetings-more-effective-with-granola-2eajeT9WU4k?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D2eajeT9WU4k">Chris Pedregal + Sam Stephenson: Making Meetings More Effective with Granola</a> (Lightspeed Venture Partners)</li>
      <li><a href="https://www.longcut.ai/v/josh-woodward-google-labs-is-rapidly-building-ai-products-from-0-to-1-3-wVLpHGstQ?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D3-wVLpHGstQ">Josh Woodward: Google Labs is Rapidly Building AI Products from 0-to-1</a> (Sequoia Capital)</li>
    </ol>

    <p>Happy holidays! If you have feedback or questions, just reply to this email. I read everything.</p>

    <p>— <a href="https://x.com/zarazhangrui">Zara</a></p>

    <p style="font-size: 12px; color: #888; font-style: italic;">P.S. I'll send these updates about once a month. <a href="${unsubscribeUrl}">Unsubscribe here</a> if you'd rather not hear from me.</p>
  </div>

  <div class="footer">
    <p>
      You are receiving this email because you signed up for Longcut.ai.
    </p>
  </div>
</body>
</html>
`;
