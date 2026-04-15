require('dotenv').config();

module.exports = {
  port: parseInt(process.env.PORT) || 3400,
  baseUrl: process.env.BASE_URL || 'http://localhost:3400',

  db: {
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME     || 'gs_graphics_db',
    user:     process.env.DB_USER     || 'gs_graphics_user',
    password: process.env.DB_PASSWORD || '',
  },

  session: {
    secret: process.env.SESSION_SECRET || 'changeme-in-production',
  },

  admin: {
    username:     process.env.ADMIN_USERNAME     || 'admin',
    passwordHash: process.env.ADMIN_PASSWORD_HASH || '',
  },

  square: {
    environment:   process.env.SQUARE_ENVIRONMENT   || 'sandbox',
    accessToken:   process.env.SQUARE_ACCESS_TOKEN  || '',
    locationId:    process.env.SQUARE_LOCATION_ID   || '',
  },

  brand: {
    name:     process.env.BRAND_NAME     || 'GS Graphics',
    tagline:  process.env.BRAND_TAGLINE  || 'Custom Apparel for Your School & Team',
    color:    process.env.BRAND_COLOR    || '#e63946',
    logoUrl:  process.env.BRAND_LOGO_URL || '',
  },
};
