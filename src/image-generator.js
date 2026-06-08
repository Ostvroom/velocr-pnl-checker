require('./fonts'); // registers fonts before any canvas is created
const { createCanvas, loadImage } = require('canvas');
const fs = require('fs').promises;
const path = require('path');
const config = require('./config');

class ImageGenerator {
  constructor() {
    this.templatePath = config.image.templatePath;
    this.outputPath = config.image.outputPath;

    // Create output directory if it doesn't exist
    this.initializeOutputDirectory();
  }

  async initializeOutputDirectory() {
    try {
      await fs.mkdir(this.outputPath, { recursive: true });
    } catch (error) {
      console.error('Error creating output directory:', error);
    }
  }

  /**
   * Generate banner image with user data
   * @param {Object} userData - User profile data
   * @param {Buffer} profileImageBuffer - Profile image buffer
   * @returns {Buffer} Generated image buffer
   */
  async generateBanner(userData, profileImageBuffer) {
    try {
      console.log(`Generating VELTCOR3 banner for ${userData.name} (@${userData.username})`);
      // Create canvas
      const canvas = createCanvas(1920, 1080);
      const ctx = canvas.getContext('2d');

      // Load images
      // Use the 'punched' template that has transparency where the gray circle was
      // This allows stickers (characters) to overlap the profile image
      // Use the manual template provided by the user (cleaned and punched)
      const template = await loadImage(path.join(__dirname, '..', 'templates', 'banner-template-manual.png'));
      const profileImage = await loadImage(profileImageBuffer);

      // 1. Draw solid white background first
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // 2. DRAW PROFILE IMAGE FIRST (Behind stickers)
      // Scanned center: 1282, 545. User wants it 0.5cm+5px up (~24px total)
      const profileCircleX = 1284;
      const profileCircleY = 521; // Final adjusted position
      const profileCircleRadius = 250;

      ctx.save();
      ctx.beginPath();
      ctx.arc(profileCircleX, profileCircleY, profileCircleRadius, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();

      const profileSize = profileCircleRadius * 2;
      ctx.drawImage(
        profileImage,
        profileCircleX - profileCircleRadius,
        profileCircleY - profileCircleRadius,
        profileSize,
        profileSize
      );
      ctx.restore();

      // 3. DRAW TEMPLATE ON TOP
      // Because it's 'punched', the transparent hole shows the profile image
      // But the character's fingers/hands are NOT transparent, so they overlap!
      ctx.drawImage(template, 0, 0);

      // 4. DRAW TEXT (Welcome + Username)
      // User removed "Welcome," text from template, so we draw it all.

      const username = `@${userData.username}`;
      ctx.fillStyle = '#c69c6c'; // Exact gold/brown color from template
      ctx.font = '38px "ChakraPetchSB"';
      ctx.textAlign = 'left';

      // "Fat Gras by 10%": Adding a subtle stroke to thicken the script font
      ctx.strokeStyle = '#c69c6c';
      ctx.lineWidth = 0.5;

      const textX = 430;
      const textY = 590;

      // Draw Username with stroke for boldness
      ctx.strokeText(username, textX, textY);
      ctx.fillText(username, textX, textY);

      // Convert to buffer
      const buffer = canvas.toBuffer('image/png');

      // Save file (optional)
      const filename = `veltcors_banner_${userData.username}_${Date.now()}.png`;
      const filePath = path.join(this.outputPath, filename);
      await fs.writeFile(filePath, buffer);

      console.log(`VELTCOR3 banner saved to: ${filePath}`);

      return buffer;
    } catch (error) {
      console.error('Error generating VELTCOR3 banner:', error);
      throw new Error(`Failed to generate image: ${error.message}`);
    }
  }

  /**
   * Create a simple template programmatically (fallback)
   */
  async createDefaultTemplate() {
    try {
      const canvas = createCanvas(800, 300);
      const ctx = canvas.getContext('2d');

      // Create gradient background
      const gradient = ctx.createLinearGradient(0, 0, 800, 300);
      gradient.addColorStop(0, '#1DA1F2');
      gradient.addColorStop(1, '#1976D2');

      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 800, 300);

      // Add decorative elements
      ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
      for (let i = 0; i < 20; i++) {
        const x = Math.random() * 800;
        const y = Math.random() * 300;
        const size = Math.random() * 50 + 10;
        ctx.beginPath();
        ctx.arc(x, y, size, 0, Math.PI * 2);
        ctx.fill();
      }

      const buffer = canvas.toBuffer('image/png');
      const templatePath = path.join(path.dirname(this.templatePath), 'banner-template.png');
      await fs.writeFile(templatePath, buffer);

      console.log(`Default template created at: ${templatePath}`);
      return templatePath;
    } catch (error) {
      console.error('Error creating default template:', error);
      throw error;
    }
  }
}

module.exports = ImageGenerator;