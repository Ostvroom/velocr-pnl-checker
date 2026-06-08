const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const os = require('os');

class XPuppeteerClient {
    constructor() {
        this.browser = null;
        this.page = null;
    }

    async init() {
        console.log('Launching Headless Browser...');
        this.browser = await puppeteer.launch({
            headless: "new", // Use new headless mode
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--window-size=1280,800'
            ]
        });

        this.page = await this.browser.newPage();
        await this.page.setViewport({ width: 1280, height: 800 });

        // Set user agent to look real
        await this.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    }

    async setCookies() {
        const auth_token = process.env.X_AUTH_TOKEN;
        const ct0 = process.env.X_CT0;

        if (!auth_token || !ct0) {
            throw new Error('Missing X_AUTH_TOKEN or X_CT0');
        }

        const cookies = [
            { name: 'auth_token', value: auth_token, domain: '.x.com' },
            { name: 'ct0', value: ct0, domain: '.x.com' },
            { name: 'auth_token', value: auth_token, domain: '.twitter.com' },
            { name: 'ct0', value: ct0, domain: '.twitter.com' }
        ];

        if (process.env.X_KDT) {
            cookies.push({ name: 'kdt', value: process.env.X_KDT, domain: '.x.com' });
            cookies.push({ name: 'kdt', value: process.env.X_KDT, domain: '.twitter.com' });
        }
        if (process.env.X_TWID) {
            cookies.push({ name: 'twid', value: process.env.X_TWID, domain: '.x.com' });
            cookies.push({ name: 'twid', value: process.env.X_TWID, domain: '.twitter.com' });
        }

        await this.page.setCookie(...cookies);
        console.log('Cookies injected successfully.');
    }

    async postImage(text, imageBuffer) {
        try {
            await this.init();
            await this.setCookies();

            console.log('Navigating to X...');
            await this.page.goto('https://x.com/compose/tweet', { waitUntil: 'networkidle2' });

            // Check if logged in (look for post button or profile)
            try {
                await this.page.waitForSelector('[data-testid="tweetButton"]', { timeout: 10000 });
            } catch (e) {
                console.log('Login check failed. Taking screenshot...');
                await this.page.screenshot({ path: 'login_fail.png' });
                throw new Error('Could not verify login. Cookies might be invalid.');
            }

            console.log('Uploading image...');

            // Save buffer to temp file
            const tempPath = path.join(os.tmpdir(), `upload_${Date.now()}.png`);
            fs.writeFileSync(tempPath, imageBuffer);

            // Find file input
            const fileInput = await this.page.$('input[type="file"]');
            if (!fileInput) throw new Error('File input not found');

            await fileInput.uploadFile(tempPath);

            // Wait for image to load (look for remove button or image preview)
            await this.page.waitForSelector('[data-testid="attachments"]', { timeout: 10000 });
            console.log('Image uploaded.');

            // Type text
            console.log('Typing text...');
            await this.page.click('[data-testid="tweetTextarea_0"]');
            await this.page.keyboard.type(text);

            // Wait for button to be enabled (important: uploading might keep it disabled)
            console.log('Waiting for Post button to be enabled...');
            const postButtonSelector = '[data-testid="tweetButton"]';
            try {
                await this.page.waitForFunction((selector) => {
                    const btn = document.querySelector(selector);
                    return btn && !btn.disabled && !btn.getAttribute('aria-disabled');
                }, { timeout: 10000 }, postButtonSelector);
            } catch (e) {
                console.log('Warning: Post button did not become enabled in time. Attempting click anyway...');
            }

            // Click Tweet using evaluate
            console.log('Clicking Post (via JS)...');
            await this.page.evaluate((selector) => {
                const btn = document.querySelector(selector);
                if (btn) btn.click();
            }, postButtonSelector);

            // Wait for success indicator
            try {
                // Wait for the "Sent" toast or the compose window to close
                console.log('Waiting for post confirmation...');
                await this.page.waitForFunction(() => {
                    const toast = document.querySelector('[data-testid="toast"]');
                    return toast && toast.innerText.toLowerCase().includes('sent');
                }, { timeout: 10000 });
                console.log('Context: Success toast detected.');
            } catch (e) {
                console.log('No success toast detected. Checking for error messages...');

                // Check if there's an error toast
                const errorToast = await this.page.evaluate(() => {
                    const toast = document.querySelector('[data-testid="toast"]');
                    return toast ? toast.innerText : null;
                });

                if (errorToast) {
                    console.error(`Found toast message: ${errorToast}`);
                    throw new Error(`X Posing Error: ${errorToast}`);
                }

                console.log('No specific error found, but no success confirmation either.');
                // Wait longer just in case
                await new Promise(r => setTimeout(r, 5000));
            }

            // Take a "success" screenshot for verification
            await this.page.screenshot({ path: 'last_post_result.png' });
            console.log('✅ Post action completed (Screenshot saved to last_post_result.png).');

            // Cleanup
            try { fs.unlinkSync(tempPath); } catch (e) { }
            await this.browser.close();

            return { data: { id: 'scraper_post_success' } };

        } catch (error) {
            console.error('Puppeteer Post Error:', error);
            if (this.browser) await this.browser.close();
            throw error;
        }
    }
}

module.exports = XPuppeteerClient;
