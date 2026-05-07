const express = require('express');
const db = require('../config/database');
const { auth, checkRole } = require('../middleware/auth');
const { notifyNewOrder, notifyOrderStatusChange, notifyDeliverersNewOrder, notifyOrderAssigned, notifyChatClosed } = require('../config/websocket');
const { calculateDistance, calculateDeliveryFee, getDeliveryFeeHybrid } = require('../utils/deliveryFee');

const router = express.Router();

// Calculate delivery fee (public endpoint - no auth required for pre-checkout calculation)
router.post('/calculate-delivery-fee', async (req, res) => {
  try {
    const { shopId, deliveryAddress } = req.body;

    if (!shopId || !deliveryAddress) {
      return res.status(400).json({
        error: { message: 'Shop ID and delivery address are required' }
      });
    }

    // Get shop coordinates
    const shopResult = await db.query(
      'SELECT latitude, longitude FROM shops WHERE id = ?',
      [shopId]
    );

    if (shopResult.rows.length === 0) {
      return res.status(404).json({
        error: { message: 'Shop not found' }
      });
    }

    const shop = shopResult.rows[0];

    if (!shop.latitude || !shop.longitude) {
      return res.status(400).json({
        error: { message: 'Shop location not configured. Cannot calculate delivery fee.' }
      });
    }

    // Geocode delivery address using Yandex (with Chechen Republic context)
    const { geocodeAddress } = require('../utils/geocoding');
    const deliveryCoords = await geocodeAddress(deliveryAddress);

    if (!deliveryCoords) {
      return res.status(400).json({
        error: { message: 'Could not geocode delivery address. Please check the address and try again.' }
      });
    }

    // Calculate delivery fee using hybrid system
    const deliveryResult = await getDeliveryFeeHybrid(
      deliveryAddress,
      shop.latitude,
      shop.longitude,
      deliveryCoords.latitude,
      deliveryCoords.longitude
    );

    res.json({
      success: true,
      data: {
        deliveryFee: deliveryResult.fee,
        deliveryDistance: deliveryResult.distance,
        deliveryLat: deliveryCoords.latitude,
        deliveryLng: deliveryCoords.longitude,
        method: deliveryResult.method || 'gps' // 'village' or 'gps'
      }
    });
  } catch (error) {
    console.error('Calculate delivery fee error:', error);
    res.status(500).json({ error: { message: 'Failed to calculate delivery fee' } });
  }
});

// Create order (customer only)
router.post('/', auth, checkRole('customer'), async (req, res) => {
  try {
    const {
      shopId,
      items,
      deliveryAddress,
      deliveryLat,
      deliveryLng,
      customerPhone,
      notes,
      deliveryType = 'delivery'
    } = req.body;

    if (!shopId || !items || items.length === 0 || !deliveryAddress) {
      return res.status(400).json({
        error: { message: 'Shop, items, and delivery address are required' }
      });
    }

    // Validate delivery coordinates only for delivery orders
    if (deliveryType === 'delivery' && (!deliveryLat || !deliveryLng)) {
      return res.status(400).json({
        error: { message: 'Delivery coordinates are required for fee calculation' }
      });
    }

    let deliveryFee = 0;
    let deliveryDistance = 0;

    // Get shop data (needed for both delivery and pickup for owner_id)
    const shopResult = await db.query(
      'SELECT latitude, longitude, owner_id FROM shops WHERE id = ?',
      [shopId]
    );

    if (shopResult.rows.length === 0) {
      return res.status(404).json({
        error: { message: 'Shop not found' }
      });
    }

    const shop = shopResult.rows[0];

    // Calculate delivery fee only for delivery orders
    if (deliveryType === 'delivery') {
      if (!shop.latitude || !shop.longitude) {
        return res.status(400).json({
          error: { message: 'Shop location not configured. Cannot calculate delivery fee.' }
        });
      }

      // Calculate delivery distance and fee using hybrid system
      // Tries custom village price first, falls back to GPS calculation
      const deliveryResult = await getDeliveryFeeHybrid(
        deliveryAddress,
        shop.latitude,
        shop.longitude,
        deliveryLat,
        deliveryLng
      );

      deliveryFee = deliveryResult.fee;
      deliveryDistance = deliveryResult.distance;
    }

    // Calculate product total
    let productTotal = 0;
    for (const item of items) {
      productTotal += item.price * item.quantity;
    }

    // Total amount = products + delivery fee
    const totalAmount = productTotal + deliveryFee;

    // Create order
    const orderResult = await db.query(
      `INSERT INTO orders (customer_id, shop_id, total_amount, delivery_fee, delivery_distance, delivery_address, delivery_lat, delivery_lng, customer_phone, notes, status, delivery_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [req.user.id, shopId, totalAmount, deliveryFee, deliveryDistance, deliveryAddress, deliveryLat || 0, deliveryLng || 0, customerPhone, notes || null, deliveryType]
    );

    const orderId = orderResult.rows.insertId;
    const orderSelectResult = await db.query(
      'SELECT * FROM orders WHERE id = ?',
      [orderId]
    );
    const order = orderSelectResult.rows[0];

    // Create order items
    for (const item of items) {
      await db.query(
        `INSERT INTO order_items (order_id, product_id, product_name, product_price, quantity, subtotal)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [order.id, item.productId, item.name, item.price, item.quantity, item.price * item.quantity]
      );

      // Update product stock
      await db.query(
        `UPDATE products
         SET stock = stock - ?
         WHERE id = ? AND stock >= ?`,
        [item.quantity, item.productId, item.quantity]
      );
    }

    // Get shop owner ID for WebSocket notification
    const shopOwnerId = shop.owner_id || null;

    // Send WebSocket notification to shop owner
    notifyNewOrder({
      id: order.id,
      customerId: req.user.id,
      shopOwnerId: shopOwnerId,
      totalAmount: parseFloat(order.total_amount),
      status: order.status,
      deliveryAddress: order.delivery_address
    });

    res.status(201).json({
      success: true,
      data: {
        id: order.id,
        shopId: order.shop_id,
        totalAmount: parseFloat(order.total_amount),
        deliveryFee: parseFloat(order.delivery_fee),
        deliveryDistance: parseFloat(order.delivery_distance),
        status: order.status,
        deliveryAddress: order.delivery_address,
        createdAt: order.created_at
      }
    });
  } catch (error) {
    console.error('Create order error:', error);
    res.status(500).json({ error: { message: 'Failed to create order' } });
  }
});

// Get my orders (customer)
router.get('/my/orders', auth, checkRole('customer'), async (req, res) => {
  try {
    const result = await db.query(
      `SELECT o.*,
              s.name as shop_name,
              s.address as shop_address,
              COUNT(oi.id) as items_count
       FROM orders o
       LEFT JOIN shops s ON o.shop_id = s.id
       LEFT JOIN order_items oi ON o.id = oi.order_id
       WHERE o.customer_id = ?
       GROUP BY o.id, s.name, s.address
       ORDER BY o.created_at DESC`,
      [req.user.id]
    );

    const orders = result.rows.map(o => ({
      id: o.id,
      shop: {
        name: o.shop_name,
        address: o.shop_address
      },
      totalAmount: parseFloat(o.total_amount),
      deliveryFee: parseFloat(o.delivery_fee || 0),
      deliveryDistance: parseFloat(o.delivery_distance || 0),
      status: o.status,
      itemsCount: parseInt(o.items_count),
      deliveryAddress: o.delivery_address,
      createdAt: o.created_at,
      updatedAt: o.updated_at
    }));

    res.json({
      success: true,
      data: orders
    });
  } catch (error) {
    console.error('Get my orders error:', error);
    res.status(500).json({ error: { message: 'Failed to get orders' } });
  }
});

// Get shop orders (seller & admin)
router.get('/shop/:shopId', auth, async (req, res) => {
  try {
    // Check if user is seller or admin
    if (req.user.role !== 'seller' && req.user.role !== 'admin') {
      return res.status(403).json({ error: { message: 'Insufficient permissions' } });
    }

    // Verify shop ownership (only for sellers, admins can view any shop)
    if (req.user.role === 'seller') {
      const shopCheck = await db.query(
        'SELECT owner_id FROM shops WHERE id = ?',
        [req.params.shopId]
      );

      if (shopCheck.rows.length === 0) {
        return res.status(404).json({ error: { message: 'Shop not found' } });
      }

      if (shopCheck.rows[0].owner_id !== req.user.id) {
        return res.status(403).json({ error: { message: 'Not authorized' } });
      }
    } else {
      // For admin, just check if shop exists
      const shopCheck = await db.query(
        'SELECT id FROM shops WHERE id = ?',
        [req.params.shopId]
      );

      if (shopCheck.rows.length === 0) {
        return res.status(404).json({ error: { message: 'Shop not found' } });
      }
    }

    const result = await db.query(
      `SELECT o.*,
              u.phone as customer_phone,
              u.first_name as customer_first_name
       FROM orders o
       LEFT JOIN users u ON o.customer_id = u.id
       WHERE o.shop_id = ?
       ORDER BY o.created_at DESC`,
      [req.params.shopId]
    );

    // Fetch all items for all orders in one query (N+1 optimization)
    let itemsByOrderId = {};
    if (result.rows.length > 0) {
      const orderIds = result.rows.map(o => o.id);
      const itemsResult = await db.query(
        `SELECT order_id, id, product_name, product_price, quantity, subtotal, is_available
         FROM order_items
         WHERE order_id IN (${orderIds.map(() => '?').join(',')})`,
        orderIds
      );

      // Group items by order_id
      itemsResult.rows.forEach(item => {
        if (!itemsByOrderId[item.order_id]) {
          itemsByOrderId[item.order_id] = [];
        }
        itemsByOrderId[item.order_id].push(item);
      });
    }

    // Map orders with their items
    const orders = result.rows.map(o => {
      const orderItems = itemsByOrderId[o.id] || [];

      return {
        id: o.id,
        customer: {
          phone: o.customer_phone,
          firstName: o.customer_first_name
        },
        totalAmount: parseFloat(o.total_amount),
        deliveryFee: parseFloat(o.delivery_fee || 0),
        status: o.status,
        items: orderItems.map(item => ({
          id: item.id,
          name: item.product_name,
          price: parseFloat(item.product_price),
          quantity: item.quantity,
          subtotal: parseFloat(item.subtotal),
          isAvailable: item.is_available === 1 || item.is_available === true
        })),
        itemsCount: orderItems.length,
        deliveryAddress: o.delivery_address,
        deliveryCoords: {
          lat: parseFloat(o.delivery_lat),
          lng: parseFloat(o.delivery_lng)
        },
        notes: o.notes,
        createdAt: o.created_at,
        updatedAt: o.updated_at
      };
    });

    res.json({
      success: true,
      data: orders
    });
  } catch (error) {
    console.error('Get shop orders error:', error);
    res.status(500).json({ error: { message: 'Failed to get orders' } });
  }
});

// Get single order with items
router.get('/:id', auth, async (req, res) => {
  try {
    // Get order
    const orderResult = await db.query(
      `SELECT o.*,
              s.name as shop_name,
              s.address as shop_address,
              s.phone as shop_phone,
              u.phone as customer_phone,
              u.first_name as customer_first_name
       FROM orders o
       LEFT JOIN shops s ON o.shop_id = s.id
       LEFT JOIN users u ON o.customer_id = u.id
       WHERE o.id = ?`,
      [req.params.id]
    );

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Order not found' } });
    }

    const order = orderResult.rows[0];

    // Check authorization
    if (req.user.role === 'customer' && order.customer_id !== req.user.id) {
      return res.status(403).json({ error: { message: 'Not authorized' } });
    }

    if (req.user.role === 'seller') {
      const shopCheck = await db.query(
        'SELECT owner_id FROM shops WHERE id = ?',
        [order.shop_id]
      );
      if (shopCheck.rows.length === 0 || shopCheck.rows[0].owner_id !== req.user.id) {
        return res.status(403).json({ error: { message: 'Not authorized' } });
      }
    }

    // Get order items
    const itemsResult = await db.query(
      'SELECT * FROM order_items WHERE order_id = ?',
      [req.params.id]
    );

    res.json({
      success: true,
      data: {
        id: order.id,
        shop: {
          name: order.shop_name,
          address: order.shop_address,
          phone: order.shop_phone
        },
        customer: {
          phone: order.customer_phone,
          firstName: order.customer_first_name
        },
        items: itemsResult.rows.map(item => ({
          id: item.id,
          productId: item.product_id,
          name: item.product_name,
          price: parseFloat(item.product_price),
          quantity: item.quantity,
          subtotal: parseFloat(item.subtotal),
          isAvailable: item.is_available === 1 || item.is_available === true
        })),
        totalAmount: parseFloat(order.total_amount),
        deliveryFee: parseFloat(order.delivery_fee || 0),
        deliveryDistance: parseFloat(order.delivery_distance || 0),
        status: order.status,
        deliveryAddress: order.delivery_address,
        deliveryCoords: {
          lat: parseFloat(order.delivery_lat),
          lng: parseFloat(order.delivery_lng)
        },
        customerPhone: order.customer_phone,
        notes: order.notes,
        createdAt: order.created_at,
        updatedAt: order.updated_at
      }
    });
  } catch (error) {
    console.error('Get order error:', error);
    res.status(500).json({ error: { message: 'Failed to get order' } });
  }
});

// Get available orders for deliverer (orders with status 'ready')
router.get('/available/deliverer', auth, checkRole('deliverer'), async (req, res) => {
  try {
    const result = await db.query(
      `SELECT o.*,
              s.name as shop_name,
              s.address as shop_address,
              s.latitude as shop_lat,
              s.longitude as shop_lng,
              u.phone as customer_phone,
              u.first_name as customer_first_name
       FROM orders o
       LEFT JOIN shops s ON o.shop_id = s.id
       LEFT JOIN users u ON o.customer_id = u.id
       WHERE o.status = 'ready' AND o.deliverer_id IS NULL AND o.delivery_type = 'delivery'
       ORDER BY o.created_at ASC`
    );

    // Fetch all items for all orders in one query (N+1 optimization)
    let itemsByOrderId = {};
    if (result.rows.length > 0) {
      const orderIds = result.rows.map(o => o.id);
      const itemsResult = await db.query(
        `SELECT order_id, id, product_name, product_price, quantity, subtotal, is_available
         FROM order_items
         WHERE order_id IN (${orderIds.map(() => '?').join(',')})`,
        orderIds
      );

      // Group items by order_id
      itemsResult.rows.forEach(item => {
        if (!itemsByOrderId[item.order_id]) {
          itemsByOrderId[item.order_id] = [];
        }
        itemsByOrderId[item.order_id].push(item);
      });
    }

    // Map orders with their items
    const orders = result.rows.map(o => {
      const orderItems = itemsByOrderId[o.id] || [];

      return {
        id: o.id,
        shop: {
          name: o.shop_name,
          address: o.shop_address,
          coordinates: {
            lat: parseFloat(o.shop_lat),
            lng: parseFloat(o.shop_lng)
          }
        },
        customer: {
          phone: o.customer_phone,
          firstName: o.customer_first_name
        },
        totalAmount: parseFloat(o.total_amount),
        status: o.status,
        delivererId: o.deliverer_id,
        items: orderItems.map(item => ({
          id: item.id,
          name: item.product_name,
          price: parseFloat(item.product_price),
          quantity: item.quantity,
          subtotal: parseFloat(item.subtotal),
          isAvailable: item.is_available === 1 || item.is_available === true
        })),
        itemsCount: orderItems.length,
        deliveryAddress: o.delivery_address,
        deliveryCoords: {
          lat: parseFloat(o.delivery_lat),
          lng: parseFloat(o.delivery_lng)
        },
        notes: o.notes,
        createdAt: o.created_at,
        updatedAt: o.updated_at
      };
    });

    res.json({
      success: true,
      data: orders
    });
  } catch (error) {
    console.error('Get available orders error:', error);
    res.status(500).json({ error: { message: 'Failed to get available orders' } });
  }
});

// Get deliverer's active orders (orders being delivered by this deliverer)
router.get('/my/deliveries/active', auth, checkRole('deliverer'), async (req, res) => {
  try {
    const result = await db.query(
      `SELECT o.*,
              s.name as shop_name,
              s.address as shop_address,
              s.latitude as shop_lat,
              s.longitude as shop_lng,
              u.phone as customer_phone,
              u.first_name as customer_first_name
       FROM orders o
       LEFT JOIN shops s ON o.shop_id = s.id
       LEFT JOIN users u ON o.customer_id = u.id
       WHERE o.status = 'delivering' AND o.deliverer_id = ?
       ORDER BY o.created_at DESC`,
      [req.user.id]
    );

    // Fetch all items for all orders in one query (N+1 optimization)
    let itemsByOrderId = {};
    if (result.rows.length > 0) {
      const orderIds = result.rows.map(o => o.id);
      const itemsResult = await db.query(
        `SELECT order_id, id, product_name, product_price, quantity, subtotal, is_available
         FROM order_items
         WHERE order_id IN (${orderIds.map(() => '?').join(',')})`,
        orderIds
      );

      // Group items by order_id
      itemsResult.rows.forEach(item => {
        if (!itemsByOrderId[item.order_id]) {
          itemsByOrderId[item.order_id] = [];
        }
        itemsByOrderId[item.order_id].push(item);
      });
    }

    // Map orders with their items
    const orders = result.rows.map(o => {
      const orderItems = itemsByOrderId[o.id] || [];

      return {
        id: o.id,
        shop: {
          name: o.shop_name,
          address: o.shop_address,
          coordinates: {
            lat: parseFloat(o.shop_lat),
            lng: parseFloat(o.shop_lng)
          }
        },
        customer: {
          phone: o.customer_phone,
          firstName: o.customer_first_name
        },
        totalAmount: parseFloat(o.total_amount),
        status: o.status,
        delivererId: o.deliverer_id,
        items: orderItems.map(item => ({
          id: item.id,
          name: item.product_name,
          price: parseFloat(item.product_price),
          quantity: item.quantity,
          subtotal: parseFloat(item.subtotal),
          isAvailable: item.is_available === 1 || item.is_available === true
        })),
        itemsCount: orderItems.length,
        deliveryAddress: o.delivery_address,
        deliveryCoords: {
          lat: parseFloat(o.delivery_lat),
          lng: parseFloat(o.delivery_lng)
        },
        notes: o.notes,
        createdAt: o.created_at,
        updatedAt: o.updated_at
      };
    });

    res.json({
      success: true,
      data: orders
    });
  } catch (error) {
    console.error('Get active deliveries error:', error);
    res.status(500).json({ error: { message: 'Failed to get active deliveries' } });
  }
});

// Get deliverer's completed orders
router.get('/my/deliveries/completed', auth, checkRole('deliverer'), async (req, res) => {
  try {
    const result = await db.query(
      `SELECT o.*,
              s.name as shop_name,
              s.address as shop_address,
              s.latitude as shop_lat,
              s.longitude as shop_lng,
              u.phone as customer_phone,
              u.first_name as customer_first_name
       FROM orders o
       LEFT JOIN shops s ON o.shop_id = s.id
       LEFT JOIN users u ON o.customer_id = u.id
       WHERE o.status = 'completed' AND o.deliverer_id = ?
       ORDER BY o.created_at DESC`,
      [req.user.id]
    );

    // Fetch all items for all orders in one query (N+1 optimization)
    let itemsByOrderId = {};
    if (result.rows.length > 0) {
      const orderIds = result.rows.map(o => o.id);
      const itemsResult = await db.query(
        `SELECT order_id, id, product_name, product_price, quantity, subtotal, is_available
         FROM order_items
         WHERE order_id IN (${orderIds.map(() => '?').join(',')})`,
        orderIds
      );

      // Group items by order_id
      itemsResult.rows.forEach(item => {
        if (!itemsByOrderId[item.order_id]) {
          itemsByOrderId[item.order_id] = [];
        }
        itemsByOrderId[item.order_id].push(item);
      });
    }

    // Map orders with their items
    const orders = result.rows.map(o => {
      const orderItems = itemsByOrderId[o.id] || [];

      return {
        id: o.id,
        shop: {
          name: o.shop_name,
          address: o.shop_address,
          coordinates: {
            lat: parseFloat(o.shop_lat),
            lng: parseFloat(o.shop_lng)
          }
        },
        customer: {
          phone: o.customer_phone,
          firstName: o.customer_first_name
        },
        totalAmount: parseFloat(o.total_amount),
        status: o.status,
        delivererId: o.deliverer_id,
        items: orderItems.map(item => ({
          id: item.id,
          name: item.product_name,
          price: parseFloat(item.product_price),
          quantity: item.quantity,
          subtotal: parseFloat(item.subtotal),
          isAvailable: item.is_available === 1 || item.is_available === true
        })),
        itemsCount: orderItems.length,
        deliveryAddress: o.delivery_address,
        deliveryCoords: {
          lat: parseFloat(o.delivery_lat),
          lng: parseFloat(o.delivery_lng)
        },
        notes: o.notes,
        createdAt: o.created_at,
        updatedAt: o.updated_at
      };
    });

    res.json({
      success: true,
      data: orders
    });
  } catch (error) {
    console.error('Get completed deliveries error:', error);
    res.status(500).json({ error: { message: 'Failed to get completed deliveries' } });
  }
});

// Accept order (deliverer)
router.put('/:id/accept', auth, checkRole('deliverer'), async (req, res) => {
  try {
    // Check if deliverer already has an active delivery
    const activeDeliveryCheck = await db.query(
      `SELECT id FROM orders
       WHERE deliverer_id = ?
       AND status IN ('delivering')`,
      [req.user.id]
    );

    if (activeDeliveryCheck.rows.length > 0) {
      return res.status(400).json({
        error: { message: 'Sie haben bereits eine aktive Lieferung. Bitte schließen Sie diese zuerst ab.' }
      });
    }

    // ATOMIC UPDATE: Assign deliverer only if order is still available
    // This prevents race conditions when multiple deliverers try to accept simultaneously
    const updateResult = await db.query(
      `UPDATE orders
       SET deliverer_id = ?, status = 'delivering'
       WHERE id = ?
         AND deliverer_id IS NULL
         AND status = 'ready'`,
      [req.user.id, req.params.id]
    );

    // Check if update was successful (affectedRows = 1 means we got the order)
    if (updateResult.affectedRows === 0) {
      // Order was either already taken, not found, or not in 'ready' status
      const orderCheck = await db.query('SELECT status, deliverer_id FROM orders WHERE id = ?', [req.params.id]);

      if (orderCheck.rows.length === 0) {
        return res.status(404).json({ error: { message: 'Order not found' } });
      }

      const order = orderCheck.rows[0];

      if (order.deliverer_id !== null) {
        return res.status(400).json({
          error: { message: 'Diese Bestellung wurde bereits von einem anderen Lieferanten angenommen' }
        });
      }

      if (order.status !== 'ready') {
        return res.status(400).json({
          error: { message: 'Order is not ready for delivery' }
        });
      }
    }

    // Get updated order data
    const result = await db.query(
      'SELECT id, status, deliverer_id, customer_id, shop_id, updated_at FROM orders WHERE id = ?',
      [req.params.id]
    );

    const orderData = result.rows[0];

    // Get shop owner ID for notification
    const shopResult = await db.query('SELECT owner_id FROM shops WHERE id = ?', [orderData.shop_id]);
    const shopOwnerId = shopResult.rows.length > 0 ? shopResult.rows[0].owner_id : null;

    // Send WebSocket notification
    notifyOrderAssigned({
      id: orderData.id,
      status: orderData.status,
      delivererId: orderData.deliverer_id,
      customerId: orderData.customer_id,
      shopOwnerId: shopOwnerId
    });

    res.json({
      success: true,
      data: {
        id: orderData.id,
        status: orderData.status,
        delivererId: orderData.deliverer_id,
        updatedAt: orderData.updated_at
      }
    });
  } catch (error) {
    console.error('Accept order error:', error);
    res.status(500).json({ error: { message: 'Failed to accept order' } });
  }
});

// Update order status (seller or deliverer)
router.put('/:id/status', auth, async (req, res) => {
  try {
    const { status, cancelReason } = req.body;

    if (!status) {
      return res.status(400).json({ error: { message: 'Status is required' } });
    }

    const validStatuses = ['pending', 'confirmed', 'preparing', 'ready', 'delivering', 'completed', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: { message: 'Invalid status' } });
    }

    // Get order
    const orderResult = await db.query(
      'SELECT * FROM orders WHERE id = ?',
      [req.params.id]
    );

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Order not found' } });
    }

    const order = orderResult.rows[0];

    // Check authorization
    if (req.user.role === 'seller') {
      const shopCheck = await db.query(
        'SELECT owner_id FROM shops WHERE id = ?',
        [order.shop_id]
      );
      if (shopCheck.rows.length === 0 || shopCheck.rows[0].owner_id !== req.user.id) {
        return res.status(403).json({ error: { message: 'Not authorized' } });
      }
    }

    // Validate status transitions - prevent invalid status changes
    const currentStatus = order.status;
    const allowedTransitions = {
      'pending': ['confirmed', 'preparing', 'ready', 'cancelled'], // Shop can mark order as ready directly
      'confirmed': ['preparing', 'cancelled'],
      'preparing': ['ready', 'cancelled'],
      'ready': ['delivering', 'cancelled'],
      'delivering': ['completed', 'cancelled'],
      'completed': [], // Cannot change from completed
      'cancelled': []  // Cannot change from cancelled
    };

    const allowed = allowedTransitions[currentStatus] || [];
    if (!allowed.includes(status)) {
      return res.status(400).json({
        error: {
          message: `Cannot change status from '${currentStatus}' to '${status}'. Allowed transitions: ${allowed.join(', ') || 'none'}`
        }
      });
    }

    // Track who cancelled and why (for admin statistics)
    let cancelledBy = null;
    let cancelReasonText = null;
    if (status === 'cancelled') {
      cancelledBy = req.user.id;
      if (!cancelReason || cancelReason.trim().length === 0) {
        return res.status(400).json({
          error: { message: 'Cancel reason is required when cancelling an order' }
        });
      }
      cancelReasonText = cancelReason.trim();
    }

    // Build update query with timestamps
    let updateQuery = 'UPDATE orders SET status = ?, cancelled_by = ?, cancel_reason = ?';
    let updateParams = [status, cancelledBy, cancelReasonText];

    // Set timestamp for the new status
    if (status === 'confirmed') {
      updateQuery += ', confirmed_at = NOW()';
    } else if (status === 'ready') {
      updateQuery += ', ready_at = NOW()';
    } else if (status === 'delivering') {
      updateQuery += ', delivering_at = NOW()';
    } else if (status === 'completed') {
      updateQuery += ', completed_at = NOW()';
    } else if (status === 'cancelled') {
      updateQuery += ', cancelled_at = NOW()';
    }

    updateQuery += ' WHERE id = ?';
    updateParams.push(req.params.id);

    // Update status with timestamps
    await db.query(updateQuery, updateParams);

    const result = await db.query(
      'SELECT id, status, updated_at FROM orders WHERE id = ?',
      [req.params.id]
    );

    // Get shop owner ID for notification
    const shopResult = await db.query('SELECT owner_id FROM shops WHERE id = ?', [order.shop_id]);
    const shopOwnerId = shopResult.rows.length > 0 ? shopResult.rows[0].owner_id : null;

    // Send WebSocket notification
    notifyOrderStatusChange({
      id: result.rows[0].id,
      status: result.rows[0].status,
      customerId: order.customer_id,
      delivererId: order.deliverer_id,
      shopOwnerId: shopOwnerId
    });

    // If status changed to 'ready', notify all deliverers
    if (status === 'ready') {
      notifyDeliverersNewOrder({
        id: result.rows[0].id,
        status: result.rows[0].status,
        shopId: order.shop_id
      });
    }

    // If order is completed or cancelled, close the chat
    if (status === 'delivered' || status === 'cancelled') {
      notifyChatClosed({
        id: result.rows[0].id,
        status: result.rows[0].status,
        customerId: order.customer_id,
        delivererId: order.deliverer_id,
        shopOwnerId: shopOwnerId
      });
    }

    res.json({
      success: true,
      data: {
        id: result.rows[0].id,
        status: result.rows[0].status,
        updatedAt: result.rows[0].updated_at
      }
    });
  } catch (error) {
    console.error('Update order status error:', error);
    res.status(500).json({ error: { message: 'Failed to update order status' } });
  }
});

// Submit rating for completed order (customer only)
router.post('/:id/rating', auth, checkRole('customer'), async (req, res) => {
  try {
    const { rating, comment } = req.body;
    const orderId = req.params.id;

    // Validate rating
    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({
        error: { message: 'Rating must be between 1 and 5' }
      });
    }

    // Get order
    const orderResult = await db.query(
      'SELECT * FROM orders WHERE id = ?',
      [orderId]
    );

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Order not found' } });
    }

    const order = orderResult.rows[0];

    // Check authorization - only the customer who placed the order can rate
    if (order.customer_id !== req.user.id) {
      return res.status(403).json({ error: { message: 'Not authorized to rate this order' } });
    }

    // Check if order is completed
    if (order.status !== 'completed') {
      return res.status(400).json({
        error: { message: 'Can only rate completed orders' }
      });
    }

    // Check if rating already exists
    const existingRating = await db.query(
      'SELECT id FROM ratings WHERE order_id = ?',
      [orderId]
    );

    if (existingRating.rows.length > 0) {
      // Update existing rating
      await db.query(
        'UPDATE ratings SET rating = ?, comment = ?, updated_at = NOW() WHERE order_id = ?',
        [rating, comment || null, orderId]
      );
    } else {
      // Insert new rating
      await db.query(
        `INSERT INTO ratings (order_id, shop_id, customer_id, rating, comment)
         VALUES (?, ?, ?, ?, ?)`,
        [orderId, order.shop_id, req.user.id, rating, comment || null]
      );
    }

    // Update shop's average rating
    const avgResult = await db.query(
      `SELECT AVG(rating) as avg_rating, COUNT(*) as review_count
       FROM ratings
       WHERE shop_id = ?`,
      [order.shop_id]
    );

    const avgRating = avgResult.rows[0].avg_rating || 0;
    const reviewCount = avgResult.rows[0].review_count || 0;

    await db.query(
      'UPDATE shops SET rating = ?, review_count = ? WHERE id = ?',
      [parseFloat(avgRating).toFixed(2), reviewCount, order.shop_id]
    );

    res.json({
      success: true,
      data: {
        orderId: orderId,
        rating: rating,
        comment: comment || null,
        shopRating: parseFloat(avgRating).toFixed(2),
        shopReviewCount: reviewCount
      }
    });
  } catch (error) {
    console.error('Submit rating error:', error);
    res.status(500).json({ error: { message: 'Failed to submit rating' } });
  }
});

// Mark order items as unavailable (seller only)
router.put('/:orderId/items/remove', auth, checkRole('seller'), async (req, res) => {
  try {
    const { removedItemIds } = req.body; // Array of item IDs to mark as unavailable
    const orderId = req.params.orderId;

    if (!removedItemIds || !Array.isArray(removedItemIds) || removedItemIds.length === 0) {
      return res.status(400).json({
        error: { message: 'removedItemIds array is required' }
      });
    }

    // Get order
    const orderResult = await db.query(
      'SELECT * FROM orders WHERE id = ?',
      [orderId]
    );

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Order not found' } });
    }

    const order = orderResult.rows[0];

    // Check authorization - only shop owner can remove items
    const shopCheck = await db.query(
      'SELECT owner_id FROM shops WHERE id = ?',
      [order.shop_id]
    );

    if (shopCheck.rows.length === 0 || shopCheck.rows[0].owner_id !== req.user.id) {
      return res.status(403).json({ error: { message: 'Not authorized' } });
    }

    // Only allow removing items from pending orders
    if (order.status !== 'pending') {
      return res.status(400).json({
        error: { message: 'Can only remove items from pending orders' }
      });
    }

    // Mark items as unavailable
    for (const itemId of removedItemIds) {
      await db.query(
        'UPDATE order_items SET is_available = FALSE WHERE id = ? AND order_id = ?',
        [itemId, orderId]
      );
    }

    // Recalculate total amount based on available items
    const itemsResult = await db.query(
      'SELECT subtotal FROM order_items WHERE order_id = ? AND is_available = TRUE',
      [orderId]
    );

    let newTotal = parseFloat(order.delivery_fee || 0);
    for (const item of itemsResult.rows) {
      newTotal += parseFloat(item.subtotal);
    }

    // Update order total
    await db.query(
      'UPDATE orders SET total_amount = ? WHERE id = ?',
      [newTotal, orderId]
    );

    res.json({
      success: true,
      data: {
        orderId: orderId,
        removedCount: removedItemIds.length,
        newTotal: newTotal
      }
    });
  } catch (error) {
    console.error('Remove order items error:', error);
    res.status(500).json({ error: { message: 'Failed to remove order items' } });
  }
});

module.exports = router;
