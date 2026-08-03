// Fonction serveur : crée une session de paiement Stripe à partir du panier
// envoyé par index.html, puis retourne l'URL de paiement Stripe à laquelle
// le navigateur du client est redirigé.
//
// IMPORTANT : la clé secrète Stripe ne doit JAMAIS être écrite dans ce fichier.
// Elle doit être ajoutée comme variable d'environnement sur Netlify :
//   Site settings → Environment variables → STRIPE_SECRET_KEY = sk_live_...

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Catalogue = source de vérité des prix (jamais fait confiance aux prix envoyés
// par le navigateur, pour éviter qu'un client modifie le prix côté client).
const PRODUCTS = {
  hoodie:   { name: 'Hoodie — Les Passionnés Motoneige',   base: 5500 }, // en cents
  crewneck: { name: 'Crewneck — Les Passionnés Motoneige', base: 4500 },
  tshirt:   { name: 'T-Shirt — Les Passionnés Motoneige',  base: 3000 }
};
const BIG_SIZES = ['2XL', '3XL'];
const SURCHARGE_CENTS = 500; // +5,00 $ pour 2XL / 3XL
const VALID_SIZES = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL'];
const LIVRAISON_CENTS = 1500; // 15,00 $
const TPS_RATE = 0.05;
const TVQ_RATE = 0.09975;

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Méthode non autorisée' }) };
  }

  let items, customer;
  try {
    const body = JSON.parse(event.body || '{}');
    items = body.items;
    customer = body.customer || {};
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Requête invalide' }) };
  }

  if (!Array.isArray(items) || items.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Le panier est vide' }) };
  }
  if (!customer.name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email || '') ||
      !customer.adresse || !customer.ville || !customer.codepostal || !customer.province) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Coordonnées client incomplètes' }) };
  }

  try {
    const line_items = items.map(function (it) {
      const prod = PRODUCTS[it.id];
      if (!prod) throw new Error('Produit inconnu : ' + it.id);
      if (VALID_SIZES.indexOf(it.size) === -1) throw new Error('Grandeur invalide : ' + it.size);

      const qty = Math.max(1, Math.min(99, parseInt(it.qty, 10) || 1));
      const unit_amount = prod.base + (BIG_SIZES.indexOf(it.size) !== -1 ? SURCHARGE_CENTS : 0);

      return {
        price_data: {
          currency: 'cad',
          product_data: { name: prod.name + ' — Grandeur ' + it.size },
          unit_amount: unit_amount
        },
        quantity: qty
      };
    });

    // ── Livraison + taxes calculées sur le sous-total, ajoutées comme lignes distinctes ──
    const subtotalCents = line_items.reduce(function (s, li) { return s + li.price_data.unit_amount * li.quantity; }, 0);
    const avantTaxesCents = subtotalCents + LIVRAISON_CENTS;
    const tpsCents = Math.round(avantTaxesCents * TPS_RATE);
    const tvqCents = Math.round(avantTaxesCents * TVQ_RATE);

    line_items.push({
      price_data: { currency: 'cad', product_data: { name: 'Livraison' }, unit_amount: LIVRAISON_CENTS },
      quantity: 1
    });
    line_items.push({
      price_data: { currency: 'cad', product_data: { name: 'TPS (5%)' }, unit_amount: tpsCents },
      quantity: 1
    });
    line_items.push({
      price_data: { currency: 'cad', product_data: { name: 'TVQ (9,975%)' }, unit_amount: tvqCents },
      quantity: 1
    });

    const siteUrl = process.env.URL || 'https://impressionpeak2peak.netlify.app';

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: line_items,
      customer_email: customer.email,
      metadata: {
        customer_name: customer.name,
        customer_phone: customer.phone || '',
        shipping_address: [customer.adresse, customer.ville, customer.province, customer.codepostal].join(', ')
      },
      success_url: siteUrl + '/merci.html?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: siteUrl + '/'
    });

    return { statusCode: 200, body: JSON.stringify({ url: session.url }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
