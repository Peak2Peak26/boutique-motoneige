// Fonction serveur : crée un lien de paiement Square à partir du panier
// envoyé par index.html, puis retourne l'URL de paiement Square à laquelle
// le navigateur du client est redirigé.
//
// IMPORTANT : le jeton d'accès Square ne doit JAMAIS être écrit dans ce fichier.
// Il doit être ajouté comme variable d'environnement sur Netlify :
//   Site settings → Environment variables → SQUARE_ACCESS_TOKEN = EAAA...
//   Site settings → Environment variables → SQUARE_LOCATION_ID  = L...

const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const SQUARE_LOCATION_ID = process.env.SQUARE_LOCATION_ID;
// Mettre 'https://connect.squareupsandbox.com' pendant les tests avec un jeton sandbox,
// puis repasser à 'https://connect.squareup.com' pour le vrai compte (production).
const SQUARE_API_BASE = process.env.SQUARE_ENV === 'sandbox'
  ? 'https://connect.squareupsandbox.com'
  : 'https://connect.squareup.com';

// Catalogue = source de vérité des prix (jamais fait confiance aux prix envoyés
// par le navigateur, pour éviter qu'un client modifie le prix côté client).
const PRODUCTS = {
  "tshirt-coton": { name: "T-Shirt Coton — Les Passionnés Motoneige", base: 3000, sizes: ["S", "M", "L", "XL", "2XL", "3XL", "4XL"] },
  "ml-coton": { name: "T-Shirt Manches Longues Coton — Les Passionnés Motoneige", base: 3500, sizes: ["S", "M", "L", "XL", "2XL", "3XL", "4XL"] },
  "crewneck": { name: "Crewneck — Les Passionnés Motoneige", base: 4500, sizes: ["XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL"] },
  "hoodie-2": { name: "Hoodie 2 logos — Les Passionnés Motoneige", base: 5000, sizes: ["XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL"] },
  "hoodie-se": { name: "Hoodie Édition Spéciale 4 logos — Les Passionnés Motoneige", base: 7000, sizes: ["XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL"], colors: ["Noir", "Moss"] },
  "tshirt-dryfit": { name: "T-Shirt Dryfit — Les Passionnés Motoneige", base: 3500, sizes: ["XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL"], colors: ["Homme", "Femme"] },
  "ml-dryfit": { name: "T-Shirt Manches Longues Dryfit — Les Passionnés Motoneige", base: 4500, sizes: ["XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL"], colors: ["Homme", "Femme"] },
  "tuque": { name: "Tuque — Les Passionnés Motoneige", base: 2900, sizes: ["Unique"] },
  "casquette": { name: "Casquette — Les Passionnés Motoneige", base: 2900, sizes: ["Unique"] }
};
const BIG_SIZES = ['2XL', '3XL', '4XL'];
const SURCHARGE_CENTS = 500; // +5,00 $ pour 2XL / 3XL / 4XL
// Livraison en cents — mêmes zones que index.html et merci.html
const LIVRAISON_STANDARD = 1500;   // Québec
const LIVRAISON_HORS_QC  = 2500;   // autres provinces
// Régions éloignées : selon les 3 premiers caractères du code postal
const ZONES_LIVRAISON = [
  { nom: 'Îles-de-la-Madeleine', codes: ['G4T'], prix: 4500 },
  { nom: 'Basse-Côte-Nord',      codes: ['G0G'], prix: 9800 },
  { nom: 'Nunavik',              codes: ['J0M'], prix: 19000 },
  { nom: 'Baie-James',           codes: ['G8P', 'G0W', 'J0Y'], prix: 2500 }
];
function zoneLivraison(codePostal) {
  const fsa = String(codePostal || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3);
  for (let i = 0; i < ZONES_LIVRAISON.length; i++) {
    if (ZONES_LIVRAISON[i].codes.indexOf(fsa) !== -1) return ZONES_LIVRAISON[i];
  }
  if (fsa.length < 3 || /^[GHJ]/.test(fsa)) return { nom: 'Québec', prix: LIVRAISON_STANDARD };
  return { nom: 'Hors Québec', prix: LIVRAISON_HORS_QC };
}
const TPS_RATE = 0.05;
const TVQ_RATE = 0.09975;

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Méthode non autorisée' }) };
  }
  if (!SQUARE_ACCESS_TOKEN || !SQUARE_LOCATION_ID) {
    return { statusCode: 500, body: JSON.stringify({ error: "Configuration Square manquante (variables d'environnement)" }) };
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
      !customer.adresse || !customer.ville || !/^[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d$/.test(customer.codepostal || '') || !customer.province) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Coordonnées client incomplètes' }) };
  }

  try {
    const zone = zoneLivraison(customer.codepostal);
    const LIVRAISON_CENTS = zone.prix;
    const line_items = items.map(function (it) {
      const prod = PRODUCTS[it.id];
      if (!prod) throw new Error('Produit inconnu : ' + it.id);
      if (prod.sizes.indexOf(it.size) === -1) throw new Error('Grandeur invalide : ' + it.size);
      let variante = '';
      if (prod.colors) {
        if (prod.colors.indexOf(it.color) === -1) throw new Error('Option invalide : ' + it.color);
        variante = ' — ' + it.color;
      }

      const qty = Math.max(1, Math.min(99, parseInt(it.qty, 10) || 1));
      const unit_amount = prod.base + (BIG_SIZES.indexOf(it.size) !== -1 ? SURCHARGE_CENTS : 0);

      return {
        name: prod.name + variante + ' — Grandeur ' + it.size,
        quantity: String(qty),
        base_price_money: { amount: unit_amount, currency: 'CAD' }
      };
    });

    // ── Livraison + taxes calculées sur le sous-total, ajoutées comme lignes distinctes ──
    const subtotalCents = line_items.reduce(function (s, li) {
      return s + li.base_price_money.amount * parseInt(li.quantity, 10);
    }, 0);
    const avantTaxesCents = subtotalCents + LIVRAISON_CENTS;
    const tpsCents = Math.round(avantTaxesCents * TPS_RATE);
    const tvqCents = Math.round(avantTaxesCents * TVQ_RATE);

    line_items.push({
      name: 'Livraison (' + zone.nom + ')',
      quantity: '1',
      base_price_money: { amount: LIVRAISON_CENTS, currency: 'CAD' }
    });
    line_items.push({
      name: 'TPS (5%)',
      quantity: '1',
      base_price_money: { amount: tpsCents, currency: 'CAD' }
    });
    line_items.push({
      name: 'TVQ (9,975%)',
      quantity: '1',
      base_price_money: { amount: tvqCents, currency: 'CAD' }
    });

    const siteUrl = process.env.URL || 'https://lespassionnes-braaap-braaap.netlify.app';

    const payload = {
      idempotency_key: (Date.now().toString(36) + Math.random().toString(36).slice(2)),
      order: {
        location_id: SQUARE_LOCATION_ID,
        // Sans ça, Square affiche la commande sous la source d'une autre boutique (même jeton).
        source: { name: "Les Passionnés Motoneige" },
        line_items: line_items
      },
      checkout_options: {
        redirect_url: siteUrl + '/merci.html',
        ask_for_shipping_address: false
      },
      pre_populated_data: {
        buyer_email: customer.email
      }
    };

    const resp = await fetch(SQUARE_API_BASE + '/v2/online-checkout/payment-links', {
      method: 'POST',
      headers: {
        'Square-Version': '2026-08-19',
        'Authorization': 'Bearer ' + SQUARE_ACCESS_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await resp.json();
    if (!resp.ok) {
      const msg = (data.errors && data.errors[0] && data.errors[0].detail) || 'Erreur Square';
      return { statusCode: 500, body: JSON.stringify({ error: msg }) };
    }

    return { statusCode: 200, body: JSON.stringify({ url: data.payment_link.url }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
