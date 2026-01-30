export const getWelcomeSubject = () => "Welcome to Little universe";

export const getWelcomeHtmlBody = (fullName?: string | null) => {
  const greeting = fullName ? `Hey ${fullName},` : 'Hey,';

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      line-height: 1.6;
      color: #333;
      max-width: 600px;
      margin: 0 auto;
      padding: 20px;
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
    a:hover {
      text-decoration: underline;
    }
    p {
      margin-bottom: 16px;
    }
    ol {
      margin-bottom: 20px;
      padding-left: 20px;
    }
    ol li {
      margin-bottom: 8px;
    }
  </style>
</head>
<body>
  <div class="content">
    <p>${greeting}</p>

    <p>I'm Zara, one of the creators of <a href="https://longcut.ai/">Little universe</a>. I just wanted to say thanks for signing up.</p>

    <p>We built Little universe to help you learn better from long YouTube videos. Here's a <a href="https://www.youtube.com/watch?v=93vIBbZ88Fs">video</a> walking through how to use it.</p>

    <p>If you have a second, I would love to hear from you on:</p>

    <ol>
      <li>What are you using Little universe for</li>
      <li>What's your favorite feature</li>
      <li>Any suggestions/feedback</li>
    </ol>

    <p>Feel free to just reply to this email. I read everything and would love to help.</p>

    <p>Best,<br>
    <a href="https://x.com/zarazhangrui">Zara Zhang</a></p>
  </div>

  <div class="footer">
    <p>
      Little universe - Don't take the shortcut in your learning; take the longcut.<br>
      <a href="https://longcut.ai">longcut.ai</a>
    </p>
  </div>
</body>
</html>
`;
};
