import { loadSiteConfig } from './loadSiteConfig';

export const getCommonSiteConfigProps = async () => {
  const siteId = process.env.SITE_ID || 'default';
  const contactEmail = process.env.CONTACT_EMAIL?.trim() || null;

  try {
    const siteConfig = await loadSiteConfig(siteId);

    if (!siteConfig) {
      throw new Error(`Configuration not found for site ID: ${siteId}`);
    }

    return {
      props: {
        siteConfig,
        contactEmail,
      },
    };
  } catch (error) {
    console.error('Error loading site config:', error);
    return {
      props: {
        siteConfig: null,
        contactEmail,
        error:
          'Failed to load site configuration. Please notify an administrator.',
      },
    };
  }
};
