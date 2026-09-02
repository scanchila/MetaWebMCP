const unsupported = async () => {
  throw new Error('Persistent filesystem access is unavailable in the Cloudflare Browser Run adapter.');
};

export default {
  promises: {
    mkdir: unsupported,
  },
};
