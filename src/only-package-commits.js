const { identity, memoizeWith, pipeP } = require('ramda');
const pkgUp = require('pkg-up');
const readPkg = require('read-pkg');
const path = require('path');
const pLimit = require('p-limit');
const debug = require('debug')('semantic-release:monorepo');
const { getCommitFiles, getRoot } = require('./git-utils');
const { mapCommits } = require('./options-transforms');

const packageJson = require(`${process.cwd()}/package.json`);
const Path = require('path');

const memoizedGetCommitFiles = memoizeWith(identity, getCommitFiles);

/**
 * Get the normalized PACKAGE root path, relative to the git PROJECT root.
 */
const getPackagePath = async () => {
  const packagePath = await pkgUp();
  const gitRoot = await getRoot();

  return path.relative(gitRoot, path.resolve(packagePath, '..'));
};

const withFiles = async commits => {
  const limit = pLimit(Number(process.env.SRM_MAX_THREADS) || 500);
  return Promise.all(
    commits.map(commit =>
      limit(async () => {
        const files = await memoizedGetCommitFiles(commit.hash);
        return { ...commit, files };
      })
    )
  );
};

const onlyPackageCommits = async commits => {
  const packagePath = await getPackagePath();

  // returns packages related to this
  const settings = packageJson['semantic-release-monorepo'] ?? {};
  const includePaths = settings['include-paths'] ?? [];

  // handle with all packages at once
  const allPackages = [packagePath, ...includePaths];

  debug('Filter commits by package path: "%s"', allPackages.join(', '));
  const commitsWithFiles = await withFiles(commits);

  return commitsWithFiles.filter(({ files, subject }) => {
    // read each file to validate if it is part of the package
    const validFile = files.find(file => {
      const fileSegments = path.normalize(file).split(path.sep);

      // validate the file in every package needed.
      // the packages will be the current package, and also all defined in the `relative-packages` key in the package.json
      return allPackages.some(pkg => {
        const pkgSegments = pkg.split(path.sep);
        return pkgSegments.every(
          (packageSegment, i) => packageSegment === fileSegments[i]
        );
      });
    });

    if (validFile) {
      debug(
        'Including commit "%s" because it modified package file "%s".',
        subject,
        validFile
      );
    }

    return !!validFile;
  });
};

// Async version of Ramda's `tap`
const tapA = fn => async x => {
  await fn(x);
  return x;
};

const logFilteredCommitCount = logger => async ({ commits }) => {
  const { name } = await readPkg();

  logger.log(
    'Found %s commits for package %s since last release',
    commits.length,
    name
  );
};

const withOnlyPackageCommits = plugin => async (pluginConfig, config) => {
  const { logger } = config;

  return plugin(
    pluginConfig,
    await pipeP(
      mapCommits(onlyPackageCommits),
      tapA(logFilteredCommitCount(logger))
    )(config)
  );
};

module.exports = withOnlyPackageCommits;
