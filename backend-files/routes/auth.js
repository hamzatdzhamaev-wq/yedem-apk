const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const db = require('../config/database');
const { auth } = require('../middleware/auth');
const { geocodeAddress } = require('../utils/geocoding');
const { sendCallOTP } = require('../services/smsc');
const { getAuthorizationUrl, authenticateUser } = require('../services/vk-oauth');

const router = express.Router();

// In-memory storage for VK OAuth PKCE (state -> code_verifier)
// Better than cookies for cross-domain issues
const vkOAuthStorage = new Map();

// Clean up old entries every 15 minutes
setInterval(() => {
  const now = Date.now();
  for (const [state, data] of vkOAuthStorage.entries()) {
    if (now - data.timestamp > 10 * 60 * 1000) { // 10 minutes
      vkOAuthStorage.delete(state);
    }
  }
}, 15 * 60 * 1000);

// Rate limiting for authentication endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limit each IP to 5 requests per windowMs
  message: { error: { message: 'Слишком много попыток. Попробуйте позже.' } },
  standardHeaders: true,
  legacyHeaders: false,
});

// Stricter rate limiting for failed login attempts
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 login attempts per windowMs
  skipSuccessfulRequests: true, // Don't count successful logins
  message: { error: { message: 'Слишком много неудачных попыток входа. Попробуйте позже.' } },
  standardHeaders: true,
  legacyHeaders: false,
});

// Register new user
router.post('/register', authLimiter, async (req, res) => {
  try {
    const {
      phone,
      password,
      role: requestedRole,
      firstName,
      lastName,
      shopName,
      shopType,
      shopAddress,
      shopLat,
      shopLng
    } = req.body;

    // SECURITY: Whitelist allowed roles for public registration
    // Admin accounts can ONLY be created manually in database or by existing admin
    const ALLOWED_ROLES = ['customer', 'seller', 'deliverer'];
    const role = ALLOWED_ROLES.includes(requestedRole) ? requestedRole : 'customer';

    // Log security violation attempts
    if (requestedRole && !ALLOWED_ROLES.includes(requestedRole)) {
      console.warn(`🚨 SECURITY: Attempted privilege escalation - Phone: ${phone}, Requested role: ${requestedRole}`);
    }

    // Validate required fields
    if (!phone || !password) {
      return res.status(400).json({
        error: { message: 'Phone and password are required' }
      });
    }

    // Check if user already exists
    const existingUser = await db.query(
      'SELECT id FROM users WHERE phone = ?',
      [phone]
    );

    if (existingUser.rows.length > 0) {
      return res.status(400).json({
        error: { message: 'User with this phone already exists' }
      });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Determine initial status
    const status = role === 'customer' ? 'active' : 'pending';

    // Debug logging
    console.log('Register params:', {
      phone,
      passwordHash,
      role,
      firstName: firstName || null,
      lastName: lastName || null,
      status
    });

    // Create user
    const result = await db.query(
      `INSERT INTO users (phone, password_hash, role, first_name, last_name, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [phone, passwordHash, role, firstName || null, lastName || null, status]
    );

    const userId = result.rows.insertId;
    console.log('User created with ID:', userId);
    const userResult = await db.query(
      'SELECT id, phone, role, first_name, last_name, status, created_at FROM users WHERE id = ?',
      [userId]
    );
    const user = userResult.rows[0];

    // If seller, create shop
    let shopId = null;
    if (role === 'seller' && shopName) {
      let latitude = shopLat;
      let longitude = shopLng;

      // If GPS coordinates not provided but address is available, try geocoding
      if ((!latitude || !longitude) && shopAddress) {
        console.log(`Attempting to geocode address: ${shopAddress}`);
        const coords = await geocodeAddress(shopAddress);
        if (coords) {
          latitude = coords.latitude;
          longitude = coords.longitude;
          console.log(`✅ Geocoding successful: ${latitude}, ${longitude}`);
        } else {
          console.warn('⚠️ Geocoding failed, shop will have no GPS coordinates');
        }
      }

      // Validate that we have coordinates (either from frontend or geocoding)
      if (!latitude || !longitude) {
        return res.status(400).json({
          error: { message: 'GPS-координаты магазина обязательны для расчета стоимости доставки. Убедитесь, что адрес указан правильно.' }
        });
      }

      console.log('Shop params:', { userId: user.id, shopName, shopType, shopAddress, latitude, longitude });
      const shopResult = await db.query(
        `INSERT INTO shops (owner_id, name, shop_type, address, latitude, longitude)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [user.id, shopName, shopType || 'grocery', shopAddress || null, latitude, longitude]
      );
      shopId = shopResult.rows.insertId;
    }

    // Generate token
    const token = jwt.sign(
      { id: user.id, phone: user.phone, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.status(201).json({
      success: true,
      data: {
        user: {
          id: user.id,
          phone: user.phone,
          role: user.role,
          firstName: user.first_name,
          lastName: user.last_name,
          status: user.status,
          shopId: shopId
        },
        token
      }
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: { message: 'Registration failed' } });
  }
});

// Login
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { phone, password } = req.body;

    if (!phone || !password) {
      return res.status(400).json({
        error: { message: 'Номер телефона и пароль обязательны' }
      });
    }

    // Find user
    const result = await db.query(
      'SELECT * FROM users WHERE phone = ?',
      [phone]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        error: { message: 'Неверный номер телефона или пароль' }
      });
    }

    const user = result.rows[0];

    // Verify password
    const validPassword = await bcrypt.compare(password, user.password_hash);

    if (!validPassword) {
      return res.status(401).json({
        error: { message: 'Неверный номер телефона или пароль' }
      });
    }

    // Get shop ID if seller
    let shopId = null;
    if (user.role === 'seller') {
      const shopResult = await db.query(
        'SELECT id FROM shops WHERE owner_id = ?',
        [user.id]
      );
      if (shopResult.rows.length > 0) {
        shopId = shopResult.rows[0].id;
      }
    }

    // Generate token
    const token = jwt.sign(
      { id: user.id, phone: user.phone, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      success: true,
      data: {
        user: {
          id: user.id,
          phone: user.phone,
          role: user.role,
          firstName: user.first_name,
          lastName: user.last_name,
          status: user.status,
          shopId: shopId
        },
        token
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: { message: 'Login failed' } });
  }
});

// Get current user
router.get('/me', auth, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id, phone, role, first_name, last_name, status, created_at FROM users WHERE id = ?',
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: { message: 'User not found' }
      });
    }

    const user = result.rows[0];

    // Get shop ID if seller
    let shopId = null;
    if (user.role === 'seller') {
      const shopResult = await db.query(
        'SELECT id FROM shops WHERE owner_id = ?',
        [user.id]
      );
      if (shopResult.rows.length > 0) {
        shopId = shopResult.rows[0].id;
      }
    }

    res.json({
      success: true,
      user: {
        id: user.id,
        phone: user.phone,
        role: user.role,
        firstName: user.first_name,
        lastName: user.last_name,
        status: user.status,
        createdAt: user.created_at,
        shopId: shopId
      }
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: { message: 'Failed to get user' } });
  }
});

// Update profile
router.put('/me', auth, async (req, res) => {
  try {
    const { firstName, lastName } = req.body;

    await db.query(
      `UPDATE users
       SET first_name = COALESCE(?, first_name),
           last_name = COALESCE(?, last_name)
       WHERE id = ?`,
      [firstName, lastName, req.user.id]
    );

    const result = await db.query(
      'SELECT id, phone, role, first_name, last_name, status FROM users WHERE id = ?',
      [req.user.id]
    );

    res.json({
      success: true,
      data: result.rows[0]
    });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: { message: 'Failed to update profile' } });
  }
});

// Delete account
router.delete('/me', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;

    // Check if deliverer has active deliveries
    if (userRole === 'deliverer') {
      const activeDeliveries = await db.query(
        `SELECT id FROM orders
         WHERE deliverer_id = ?
           AND status IN ('delivering', 'ready', 'preparing', 'confirmed', 'pending')`,
        [userId]
      );

      if (activeDeliveries.rows.length > 0) {
        return res.status(400).json({
          error: {
            message: `Невозможно удалить аккаунт. У вас есть ${activeDeliveries.rows.length} активных заказов. Пожалуйста, завершите все доставки перед удалением аккаунта.`
          }
        });
      }
    }

    // Check if seller has a shop with active orders
    if (userRole === 'seller') {
      const shopCheck = await db.query(
        'SELECT id FROM shops WHERE owner_id = ?',
        [userId]
      );

      if (shopCheck.rows.length > 0) {
        const shopId = shopCheck.rows[0].id;
        const activeOrders = await db.query(
          `SELECT id FROM orders
           WHERE shop_id = ?
             AND status IN ('delivering', 'ready', 'preparing', 'confirmed', 'pending')`,
          [shopId]
        );

        if (activeOrders.rows.length > 0) {
          return res.status(400).json({
            error: {
              message: `Невозможно удалить аккаунт. Ваш магазин имеет ${activeOrders.rows.length} активных заказов. Пожалуйста, завершите все заказы перед удалением аккаунта.`
            }
          });
        }
      }
    }

    // Delete user (CASCADE will handle related data)
    await db.query('DELETE FROM users WHERE id = ?', [userId]);

    res.json({
      success: true,
      message: 'Account deleted successfully'
    });
  } catch (error) {
    console.error('Delete account error:', error);
    res.status(500).json({ error: { message: 'Failed to delete account' } });
  }
});

// ============================================
// CALL-OTP ENDPOINTS (Customer Registration Only)
// ============================================

// Send Call-OTP (Only for customers during registration)
router.post('/send-call-otp', authLimiter, async function(req, res) {
  try {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({
        success: false,
        error: { message: 'Номер телефона обязателен' }
      });
    }

    // Check if phone is already registered
    const existingUser = await db.query(
      'SELECT id FROM users WHERE phone = ?',
      [phone]
    );

    if (existingUser.rows.length > 0) {
      return res.status(400).json({
        success: false,
        error: { message: 'Этот номер телефона уже зарегистрирован' }
      });
    }

    // Generate 6-digit OTP code
    const code = Math.floor(100000 + Math.random() * 900000).toString();

    // Delete any existing OTP for this phone
    await db.query(
      'DELETE FROM otp_codes WHERE phone = ?',
      [phone]
    );

    // Store OTP in database (expires in 5 minutes)
    await db.query(
      'INSERT INTO otp_codes (phone, code, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 5 MINUTE))',
      [phone, code]
    );

    // Send Call-OTP via SMSC
    const result = await sendCallOTP(phone, code);

    if (!result.success) {
      return res.status(500).json({
        success: false,
        error: { message: 'Не удалось отправить код. Попробуйте позже.' }
      });
    }

    res.json({
      success: true,
      message: 'Код отправлен. Ожидайте звонка.'
    });

  } catch (error) {
    console.error('Send Call-OTP error:', error);
    res.status(500).json({
      success: false,
      error: { message: 'Ошибка отправки кода' }
    });
  }
});

// Verify Call-OTP and complete customer registration
router.post('/verify-call-otp', authLimiter, async function(req, res) {
  try {
    const { phone, code, firstName, lastName, password } = req.body;

    if (!phone || !code) {
      return res.status(400).json({
        success: false,
        error: { message: 'Номер телефона и код обязательны' }
      });
    }

    if (!firstName || !password) {
      return res.status(400).json({
        success: false,
        error: { message: 'Имя и пароль обязательны' }
      });
    }

    // Find valid OTP code
    const otpResult = await db.query(
      'SELECT * FROM otp_codes WHERE phone = ? AND code = ? AND expires_at > NOW() AND verified = 0',
      [phone, code]
    );

    if (otpResult.rows.length === 0) {
      // Increment failed attempts
      await db.query(
        'UPDATE otp_codes SET attempts = attempts + 1 WHERE phone = ? AND code = ?',
        [phone, code]
      );

      return res.status(400).json({
        success: false,
        error: { message: 'Неверный или истекший код' }
      });
    }

    const otpRecord = otpResult.rows[0];

    // Check attempts (max 3)
    if (otpRecord.attempts >= 3) {
      return res.status(400).json({
        success: false,
        error: { message: 'Слишком много попыток. Запросите новый код.' }
      });
    }

    // Mark OTP as verified
    await db.query(
      'UPDATE otp_codes SET verified = 1 WHERE id = ?',
      [otpRecord.id]
    );

    // Check again if user exists (race condition protection)
    const existingUser = await db.query(
      'SELECT id FROM users WHERE phone = ?',
      [phone]
    );

    if (existingUser.rows.length > 0) {
      return res.status(400).json({
        success: false,
        error: { message: 'Этот номер телефона уже зарегистрирован' }
      });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create customer account
    const result = await db.query(
      'INSERT INTO users (phone, password_hash, role, first_name, last_name, status, created_at) VALUES (?, ?, ?, ?, ?, ?, NOW())',
      [phone, hashedPassword, 'customer', firstName, lastName || null, 'active']
    );

    const userId = result.rows.insertId;

    // Generate JWT token
    const token = jwt.sign(
      { id: userId, phone: phone, role: 'customer' },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: '30d' }
    );

    // Clean up used OTP
    await db.query(
      'DELETE FROM otp_codes WHERE phone = ?',
      [phone]
    );

    res.json({
      success: true,
      token: token,
      user: {
        id: userId,
        phone: phone,
        role: 'customer',
        firstName: firstName,
        lastName: lastName
      }
    });

  } catch (error) {
    console.error('Verify Call-OTP error:', error);
    res.status(500).json({
      success: false,
      error: { message: 'Ошибка проверки кода' }
    });
  }
});

// ============================================
// VK ID OAuth Endpoints
// ============================================

/**
 * GET /auth/vk
 * Initiate VK OAuth flow
 */
router.get('/vk', (req, res) => {
  try {
    const { url, state, code_verifier } = getAuthorizationUrl();

    console.log('[VK] Generated auth URL with PKCE - VK will provide device_id in callback');

    // Store PKCE code_verifier in memory
    vkOAuthStorage.set(state, {
      code_verifier: code_verifier,
      timestamp: Date.now()
    });

    res.json({
      success: true,
      authUrl: url
    });
  } catch (error) {
    console.error('VK OAuth initiation error:', error);
    res.status(500).json({
      success: false,
      error: { message: 'Не удалось инициировать вход через VK' }
    });
  }
});

/**
 * GET /auth/vk/callback
 * Handle VK OAuth callback
 */
router.get('/vk/callback', async (req, res) => {
  try {
    const { code, state, device_id } = req.query; // device_id comes from VK!

    console.log('[VK Callback] code:', code ? 'present' : 'missing');
    console.log('[VK Callback] device_id from VK:', device_id);

    if (!code) {
      return res.status(400).json({
        success: false,
        error: { message: 'Отсутствует код авторизации' }
      });
    }

    // Verify state
    const storedData = vkOAuthStorage.get(state);

    if (!storedData) {
      console.warn('VK OAuth state not found or expired');
      return res.status(400).json({
        success: false,
        error: { message: 'Сессия истекла. Попробуйте войти снова.' }
      });
    }

    const codeVerifier = storedData.code_verifier;

    // Delete used state from storage
    vkOAuthStorage.delete(state);

    // Authenticate with VK (PKCE + device_id from VK callback)
    const vkUser = await authenticateUser(code, codeVerifier, device_id);

    // Check if user already exists by VK ID
    let user = await db.query(
      'SELECT id, phone, role, first_name, last_name, status FROM users WHERE vk_id = ?',
      [vkUser.vk_id]
    );

    let userId, phone, role, firstName, lastName, status;

    if (user.rows.length > 0) {
      // Existing VK user - login
      const existingUser = user.rows[0];
      userId = existingUser.id;
      phone = existingUser.phone;
      role = existingUser.role;
      firstName = existingUser.first_name;
      lastName = existingUser.last_name;
      status = existingUser.status;

      // Check if account is active
      if (status !== 'active') {
        return res.status(403).json({
          success: false,
          error: { message: 'Ваш аккаунт ожидает проверки администратором' }
        });
      }
    } else {
      // New VK user - create customer account
      const result = await db.query(
        `INSERT INTO users (vk_id, first_name, last_name, role, status, created_at)
         VALUES (?, ?, ?, 'customer', 'active', NOW())`,
        [vkUser.vk_id, vkUser.first_name, vkUser.last_name]
      );

      userId = result.rows.insertId;
      phone = null;
      role = 'customer';
      firstName = vkUser.first_name;
      lastName = vkUser.last_name;
      status = 'active';
    }

    // Generate JWT token
    const token = jwt.sign(
      { id: userId, vk_id: vkUser.vk_id, role: role },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: '30d' }
    );

    // Return JSON response with token
    res.json({
      success: true,
      token: token,
      user: {
        id: userId,
        phone: phone,
        firstName: firstName,
        lastName: lastName,
        role: role,
        vk_id: vkUser.vk_id
      }
    });

  } catch (error) {
    console.error('VK OAuth callback error:', error);
    res.status(400).json({
      success: false,
      error: { message: error.message || 'VK Authentifizierung fehlgeschlagen' }
    });
  }
});

/**
 * POST /auth/update-phone
 * Update phone number for VK users
 */
router.post('/update-phone', auth, async (req, res) => {
  try {
    const { phone } = req.body;
    const userId = req.user.id;

    // Validate phone number
    if (!phone || typeof phone !== 'string') {
      return res.status(400).json({
        success: false,
        error: { message: 'Telefonnummer ist erforderlich' }
      });
    }

    // Phone validation: must start with + and contain only digits
    const phoneRegex = /^\+\d{10,15}$/;
    if (!phoneRegex.test(phone)) {
      return res.status(400).json({
        success: false,
        error: { message: 'Ungültige Telefonnummer. Format: +79XXXXXXXXX' }
      });
    }

    // Check if phone already exists for another user
    const existingPhone = await db.query(
      'SELECT id FROM users WHERE phone = ? AND id != ?',
      [phone, userId]
    );

    if (existingPhone.rows.length > 0) {
      return res.status(400).json({
        success: false,
        error: { message: 'Diese Telefonnummer wird bereits verwendet' }
      });
    }

    // Update phone number
    await db.query(
      'UPDATE users SET phone = ?, updated_at = NOW() WHERE id = ?',
      [phone, userId]
    );

    res.json({
      success: true,
      message: 'Telefonnummer erfolgreich hinzugefügt'
    });

  } catch (error) {
    console.error('Update phone error:', error);
    res.status(500).json({
      success: false,
      error: { message: 'Telefonnummer konnte nicht aktualisiert werden' }
    });
  }
});

/**
 * POST /auth/vk/link
 * Link existing phone account with VK ID
 */
router.post('/vk/link', auth, async (req, res) => {
  try {
    const { code } = req.body;
    const userId = req.user.id;

    if (!code) {
      return res.status(400).json({
        success: false,
        error: { message: 'Отсутствует код авторизации VK' }
      });
    }

    // Authenticate with VK
    const vkUser = await authenticateUser(code);

    // Check if VK ID is already linked to another account
    const existingVkUser = await db.query(
      'SELECT id FROM users WHERE vk_id = ? AND id != ?',
      [vkUser.vk_id, userId]
    );

    if (existingVkUser.rows.length > 0) {
      return res.status(400).json({
        success: false,
        error: { message: 'Этот VK аккаунт уже привязан к другому пользователю' }
      });
    }

    // Link VK ID to current user
    await db.query(
      'UPDATE users SET vk_id = ? WHERE id = ?',
      [vkUser.vk_id, userId]
    );

    res.json({
      success: true,
      message: 'VK аккаунт успешно привязан'
    });

  } catch (error) {
    console.error('VK link error:', error);
    res.status(500).json({
      success: false,
      error: { message: 'Не удалось привязать VK аккаунт' }
    });
  }
});

// Delete account (GDPR/ФЗ-152 Right to be Forgotten)
router.delete('/delete-account', auth, async (req, res) => {
  try {
    const userId = req.user.id;

    // Start transaction
    await db.query('START TRANSACTION');

    try {
      // Delete user's orders
      await db.query('DELETE FROM orders WHERE user_id = ?', [userId]);

      // If user is a seller, delete their shop data
      const shops = await db.query('SELECT id FROM shops WHERE owner_id = ?', [userId]);

      for (const shop of shops.rows) {
        const shopId = shop.id;

        // Delete products
        await db.query('DELETE FROM products WHERE shop_id = ?', [shopId]);

        // Delete subcategories
        await db.query('DELETE FROM subcategories WHERE shop_id = ?', [shopId]);

        // Delete categories
        await db.query('DELETE FROM categories WHERE shop_id = ?', [shopId]);

        // Delete shop
        await db.query('DELETE FROM shops WHERE id = ?', [shopId]);
      }

      // Delete user account
      await db.query('DELETE FROM users WHERE id = ?', [userId]);

      await db.query('COMMIT');

      res.json({
        success: true,
        message: 'Аккаунт успешно удален'
      });

    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    }

  } catch (error) {
    console.error('Delete account error:', error);
    res.status(500).json({
      success: false,
      error: { message: 'Не удалось удалить аккаунт' }
    });
  }
});

// Change password (requires authentication)
router.post('/change-password', auth, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;

    if (!oldPassword || !newPassword) {
      return res.status(400).json({
        error: { message: 'Старый и новый пароль обязательны' }
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        error: { message: 'Новый пароль должен содержать минимум 6 символов' }
      });
    }

    // Get current user
    const result = await db.query(
      'SELECT * FROM users WHERE id = ?',
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: { message: 'Пользователь не найден' }
      });
    }

    const user = result.rows[0];

    // Verify old password
    const validPassword = await bcrypt.compare(oldPassword, user.password_hash);

    if (!validPassword) {
      return res.status(401).json({
        error: { message: 'Неверный текущий пароль' }
      });
    }

    // Hash new password
    const newPasswordHash = await bcrypt.hash(newPassword, 10);

    // Update password
    await db.query(
      'UPDATE users SET password_hash = ? WHERE id = ?',
      [newPasswordHash, req.user.id]
    );

    res.json({
      success: true,
      message: 'Пароль успешно изменен'
    });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({
      error: { message: 'Ошибка при изменении пароля' }
    });
  }
});

// Request password reset (send SMS code)
router.post('/forgot-password/request', authLimiter, async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({
        error: { message: 'Номер телефона обязателен' }
      });
    }

    // Check if user exists
    const result = await db.query(
      'SELECT id FROM users WHERE phone = ?',
      [phone]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: { message: 'Пользователь с таким номером не найден' }
      });
    }

    // Generate 4-digit OTP code (last 4 digits of phone number)
    const code = Math.floor(1000 + Math.random() * 9000).toString();

    // Delete any existing OTP for this phone
    await db.query(
      'DELETE FROM otp_codes WHERE phone = ?',
      [phone]
    );

    // Store OTP in database (expires in 5 minutes)
    await db.query(
      'INSERT INTO otp_codes (phone, code, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 5 MINUTE))',
      [phone, code]
    );

    // Send OTP via call
    const otpResult = await sendCallOTP(phone, code);

    if (!otpResult.success) {
      return res.status(500).json({
        error: { message: 'Не удалось отправить код. Попробуйте позже.' }
      });
    }

    res.json({
      success: true,
      message: 'Код отправлен звонком на ваш номер'
    });
  } catch (error) {
    console.error('Forgot password request error:', error);
    res.status(500).json({
      error: { message: 'Ошибка при отправке кода' }
    });
  }
});

// Reset password with OTP code
router.post('/forgot-password/reset', authLimiter, async (req, res) => {
  try {
    const { phone, code, newPassword } = req.body;

    if (!phone || !code || !newPassword) {
      return res.status(400).json({
        error: { message: 'Все поля обязательны' }
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        error: { message: 'Пароль должен содержать минимум 6 символов' }
      });
    }

    // Verify OTP code
    const otpResult = await db.query(
      'SELECT * FROM otp_codes WHERE phone = ? AND code = ? AND expires_at > NOW() AND verified = 0',
      [phone, code]
    );

    if (otpResult.rows.length === 0) {
      return res.status(400).json({
        error: { message: 'Неверный или истекший код' }
      });
    }

    const otpRecord = otpResult.rows[0];

    // Check attempts (max 3)
    if (otpRecord.attempts >= 3) {
      return res.status(400).json({
        error: { message: 'Слишком много попыток. Запросите новый код.' }
      });
    }

    // Mark OTP as verified
    await db.query(
      'UPDATE otp_codes SET verified = 1 WHERE id = ?',
      [otpRecord.id]
    );

    // Hash new password
    const newPasswordHash = await bcrypt.hash(newPassword, 10);

    // Update password
    await db.query(
      'UPDATE users SET password_hash = ? WHERE phone = ?',
      [newPasswordHash, phone]
    );

    res.json({
      success: true,
      message: 'Пароль успешно изменен'
    });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({
      error: { message: 'Ошибка при сбросе пароля' }
    });
  }
});

module.exports = router;
