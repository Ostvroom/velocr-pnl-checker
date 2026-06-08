const axios = require('axios');
const cheerio = require('cheerio');
const config = require('./config');
const { TwitterApi } = require('twitter-api-v2');
const { Scraper } = require('agent-twitter-client');

// Configure axios with better timeout and retry settings
const axiosInstance = axios.create({
  timeout: 20000,
  maxRedirects: 5,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  }
});

const XPuppeteerClient = require('./x-puppeteer');

class XApiClient {
  constructor() {
    this.scraper = new Scraper();
    this.puppeteerClient = new XPuppeteerClient();
    this.useManualAuth = !!(process.env.X_AUTH_TOKEN && process.env.X_CT0);
    this.useCredentialsAuth = !!(process.env.X_BOT_USERNAME && process.env.X_BOT_PASSWORD);

    if (config.x.apiKey && config.x.accessToken) {
      this.twitterClient = new TwitterApi({
        appKey: config.x.apiKey,
        appSecret: config.x.apiSecret,
        accessToken: config.x.accessToken,
        accessSecret: config.x.accessTokenSecret,
      });
      this.v1Client = this.twitterClient.v1;
      this.v2Client = this.twitterClient.v2;
    }
  }

  async getUserProfile(username) {
    try {
      console.log(`Fetching profile for @${username}`);
      const cleanUsername = username.startsWith('@') ? username.slice(1) : username;

      if (config.x.bearerToken && config.x.bearerToken !== 'your_x_bearer_token_here') {
        try {
          const response = await axiosInstance.get(
            `https://api.twitter.com/2/users/by/username/${cleanUsername}`,
            {
              headers: { 'Authorization': `Bearer ${config.x.bearerToken}` },
              params: { 'user.fields': 'id,name,username,profile_image_url,verified' }
            }
          );
          if (response.data.data) {
            const user = response.data.data;
            return {
              id: user.id,
              name: user.name,
              username: user.username,
              profileImageUrl: user.profile_image_url.replace('_normal', '_400x400'),
              verified: user.verified || false
            };
          }
        } catch (e) { /* fallback */ }
      }

      let profileImageUrl = null;
      let displayName = cleanUsername;

      try {
        const syndicationUrl = `https://syndication.twitter.com/srv/timeline-profile/screen-name/${cleanUsername}`;
        const response = await axiosInstance.get(syndicationUrl);
        if (response.data) {
          const $ = cheerio.load(response.data);
          const imgSrc = $('img[src*="pbs.twimg.com/profile_images"]').first().attr('src');
          if (imgSrc) profileImageUrl = imgSrc.replace('_normal', '_400x400');
          const nameText = $('[data-testid="User-Name"]').first().text();
          if (nameText) displayName = nameText.split('@')[0].trim();
        }
      } catch (e) { /* fallback */ }

      if (!profileImageUrl) {
        profileImageUrl = `https://unavatar.io/twitter/${cleanUsername}`;
      }

      return {
        id: `alt_${cleanUsername}`,
        name: displayName,
        username: cleanUsername,
        profileImageUrl,
        verified: false
      };
    } catch (error) {
      return {
        id: `default_${username}`,
        name: username,
        username: username,
        profileImageUrl: 'https://abs.twimg.com/sticky/default_profile_images/default_profile_400x400.png',
        verified: false
      };
    }
  }

  async downloadImage(imageUrl) {
    try {
      const response = await axiosInstance({ url: imageUrl, responseType: 'arraybuffer' });
      return Buffer.from(response.data);
    } catch (error) {
      const defaultImage = await axiosInstance({
        url: 'https://abs.twimg.com/sticky/default_profile_images/default_profile_400x400.png',
        responseType: 'arraybuffer'
      });
      return Buffer.from(defaultImage.data);
    }
  }

  async postToX(imageBuffer, text) {
    try {
      if (this.useManualAuth) {
        console.log('Attempting Manual Posting via Puppeteer (Headless Browser)...');
        return await this.puppeteerClient.postImage(text, imageBuffer);
      }

      if (this.useCredentialsAuth) {
        console.log(`Attempting Free Posting via scraper login...`);
        try {
          await this.scraper.login(process.env.X_BOT_USERNAME, process.env.X_BOT_PASSWORD, process.env.X_BOT_EMAIL);
          const media = [{ data: imageBuffer, mediaType: 'image/png' }];
          await this.scraper.sendTweet(text, undefined, media);
          return { data: { id: 'scraper_post_success' } };
        } catch (e) {
          console.error('Scraper login failed:', e.message);
        }
      }

      if (this.v1Client) {
        const mediaId = await this.v1Client.uploadMedia(imageBuffer, { type: 'png' });
        const tweet = await this.v2Client.tweet({ text, media: { media_ids: [mediaId] } });
        return tweet;
      }

      throw new Error('No valid X authentication found (Cookies, Login, or API Keys)');
    } catch (error) {
      throw new Error(`Failed to post to X: ${error.message}`);
    }
  }

  async manualPostToX(imageBuffer, text) {
    const auth_token = process.env.X_AUTH_TOKEN;
    const ct0 = process.env.X_CT0;

    const cookies = [
      `auth_token=${auth_token}`,
      `ct0=${ct0}`,
      process.env.X_KDT ? `kdt=${process.env.X_KDT}` : null,
      process.env.X_TWID ? `twid=${process.env.X_TWID}` : null,
      process.env.X_TWITTER_SESS ? `_twitter_sess=${process.env.X_TWITTER_SESS}` : null
    ].filter(Boolean).join('; ');

    const headers = {
      'Authorization': 'Bearer AAAAAAAAAAAAAAAAAAAAAFQODgEAAAAAVHTp76lzh3rFzcHbmHVvQxYYpTw%3DckAlMINMjmCwxUcaXbAN4XqJVdgMJaHqNOFgPMK0zN1qLqLQCF',
      'Cookie': cookies,
      'x-csrf-token': ct0,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://x.com/',
      'x-twitter-active-user': 'yes',
      'x-twitter-auth-type': 'OAuth2Client',
      'x-twitter-client-language': 'en'
    };

    try {
      console.log('Uploading media manually...');
      const formData = new FormData();
      // In Node.js environment, we need to handle the buffer correctly for FormData
      const blob = new Blob([imageBuffer], { type: 'image/png' });
      formData.append('media', blob, 'banner.png');

      const uploadRes = await axios.post('https://upload.twitter.com/1.1/media/upload.json', formData, {
        headers: {
          ...headers,
          // DO NOT set Content-Type manually, let the FormData handled by axios set it with the correct boundary
        }
      });

      const mediaId = uploadRes.data.media_id_string;
      console.log(`✅ Media uploaded manually: ${mediaId}`);

      console.log('Sending tweet manually...');

      // Use the queryId found in the local node_modules
      const queryId = "a1p9RWpkYKBjWv_I3WzS-A";
      const payload = {
        variables: {
          tweet_text: text,
          dark_request: false,
          media: { media_entities: [{ media_id: mediaId, tagged_users: [] }], possibly_sensitive: false },
          semantic_annotation_ids: []
        },
        features: {
          interactive_text_enabled: true,
          longform_notetweets_inline_media_enabled: false,
          responsive_web_text_conversations_enabled: false,
          tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: false,
          vibe_api_enabled: false,
          rweb_lists_timeline_redesign_enabled: true,
          responsive_web_graphql_exclude_directive_enabled: true,
          verified_phone_label_enabled: false,
          creator_subscriptions_tweet_preview_api_enabled: true,
          responsive_web_graphql_timeline_navigation_enabled: true,
          responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
          tweetypie_unmention_optimization_enabled: true,
          responsive_web_edit_tweet_api_enabled: true,
          graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
          view_counts_everywhere_api_enabled: true,
          longform_notetweets_consumption_enabled: true,
          tweet_awards_web_tipping_enabled: false,
          freedom_of_speech_not_reach_fetch_enabled: true,
          standardized_nudges_misinfo: true,
          longform_notetweets_rich_text_read_enabled: true,
          responsive_web_enhance_cards_enabled: false,
          subscriptions_verification_info_enabled: true,
          subscriptions_verification_info_reason_enabled: true,
          subscriptions_verification_info_verified_since_enabled: true,
          super_follow_badge_privacy_enabled: false,
          super_follow_exclusive_tweet_notifications_enabled: false,
          super_follow_tweet_api_enabled: false,
          super_follow_user_api_enabled: false,
          android_graphql_skip_api_media_color_palette: false,
          creator_subscriptions_subscription_count_enabled: false,
          blue_business_profile_image_shape_enabled: false,
          unified_cards_ad_metadata_container_dynamic_card_content_query_enabled: false,
          rweb_video_timestamps_enabled: false,
          c9s_tweet_anatomy_moderator_badge_enabled: false,
          responsive_web_twitter_article_tweet_consumption_enabled: false
        },
        queryId: queryId
      };

      const tweetRes = await axios.post(`https://twitter.com/i/api/graphql/${queryId}/CreateTweet`, payload, {
        headers: { ...headers, 'Content-Type': 'application/json' }
      });

      if (tweetRes.data.errors) {
        throw new Error(tweetRes.data.errors[0].message);
      }

      console.log('✅ Tweet posted manually!');
      return { data: { id: tweetRes.data.data.create_tweet.tweet_results.result.rest_id } };
    } catch (error) {
      if (error.response && error.response.data) {
        const detail = typeof error.response.data === 'string' ? error.response.data : JSON.stringify(error.response.data);
        console.error('X Manual API Error Detail:', detail);
      }
      throw new Error(`Manual X post failed: ${error.message}`);
    }
  }
}

module.exports = XApiClient;