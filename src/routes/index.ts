import { Router } from 'express';
import auth from './auth';
import projects from './projects';

const router = Router();

router.use('/', auth);
router.use('/project', projects);

export default router;
